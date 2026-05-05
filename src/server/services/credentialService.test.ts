import { afterEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";

import type {
  AuditEntry,
  Credential,
  CredentialAuditEvent,
  StoredCredentialSummary,
} from "../../../packages/shared/src/credentials/types.js";
import type { OAuthClientConfigRecord } from "../../../packages/shared/src/credentials/oauthClientConfigStore.js";
import { createCredentialService } from "./credentialService.js";
import { CredentialSessionGrantStore } from "./credentialSessionGrants.js";

class MemoryCredentialStore {
  private readonly credentials = new Map<string, Credential>();

  async save(credential: Credential): Promise<void> {
    this.credentials.set(`${credential.providerId}:${credential.connectionId}`, credential);
  }

  async saveUrlBound(credential: Credential & { id: string }): Promise<void> {
    this.credentials.set(`url-bound:${credential.id}`, {
      ...credential,
      providerId: "url-bound",
      connectionId: credential.id,
    });
  }

  async load(providerId: string, connectionId: string): Promise<Credential | null> {
    return this.credentials.get(`${providerId}:${connectionId}`) ?? null;
  }

  async loadUrlBound(id: string): Promise<Credential | null> {
    return this.credentials.get(`url-bound:${id}`) ?? null;
  }

  async list(providerId?: string): Promise<Credential[]> {
    return [...this.credentials.values()].filter((credential) =>
      providerId ? credential.providerId === providerId : true
    );
  }

  async listUrlBound(): Promise<Credential[]> {
    return [...this.credentials.values()].filter((credential) => credential.providerId === "url-bound");
  }

  async remove(providerId: string, connectionId: string): Promise<void> {
    this.credentials.delete(`${providerId}:${connectionId}`);
  }

  async removeUrlBound(id: string): Promise<void> {
    this.credentials.delete(`url-bound:${id}`);
  }
}

class MemoryAuditLog {
  readonly entries: CredentialAuditEvent[] = [];

  async append(entry: CredentialAuditEvent): Promise<void> {
    this.entries.push(entry);
  }

  async query(): Promise<CredentialAuditEvent[]> {
    return this.entries;
  }
}

class MemoryOAuthClientConfigStore {
  private readonly records = new Map<string, OAuthClientConfigRecord>();

  async save(record: OAuthClientConfigRecord): Promise<void> {
    this.records.set(record.configId, record);
  }

  async load(configId: string): Promise<OAuthClientConfigRecord | null> {
    return this.records.get(configId) ?? null;
  }

  async loadVersion(configId: string, version: string) {
    const record = await this.load(configId);
    return record?.versions?.[version] ?? null;
  }

  async remove(configId: string): Promise<void> {
    this.records.delete(configId);
  }

  summarize(
    configId: string,
    record: OAuthClientConfigRecord | null,
    requestedFields?: readonly { name: string; type: "text" | "secret" }[],
  ) {
    const fields: Record<string, { configured: boolean; type: "text" | "secret"; updatedAt?: number }> = {};
    const names = requestedFields?.length
      ? requestedFields
      : Object.entries(record?.fields ?? {}).map(([name, field]) => ({ name, type: field.type }));
    for (const field of names) {
      const stored = record?.fields[field.name];
      fields[field.name] = {
        configured: !!stored?.value,
        type: field.type,
        updatedAt: stored?.updatedAt,
      };
    }
    return {
      configId,
      configured: Object.values(fields).every((field) => field.configured),
      authorizeUrl: record?.authorizeUrl,
      tokenUrl: record?.tokenUrl,
      fields,
      updatedAt: record?.updatedAt,
    };
  }
}

function jwtWithPayload(payload: Record<string, unknown>): string {
  return [
    "header",
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

function approvingQueue(decision: "once" | "session" | "version" | "repo" = "version") {
  return {
    request: vi.fn(async () => decision),
    requestOAuthClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
    requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
    resolve: vi.fn(),
    submitOAuthClientConfig: vi.fn(),
    submitCredentialInput: vi.fn(),
    listPending: vi.fn(() => []),
  };
}

function targetedOpenEventService(emit: ReturnType<typeof vi.fn>) {
  return {
    emit,
    emitTo: vi.fn((callerId: string, event: string, payload: unknown) => {
      emit(event, payload);
      return callerId.length > 0;
    }),
  };
}

async function startOAuthConnection(
  service: ReturnType<typeof createCredentialService>,
  emit: ReturnType<typeof vi.fn>,
  ctx: { callerId: string; callerKind: "panel" },
  request: unknown,
) {
  const pending = service.handler(ctx, "connectOAuth", [request]) as Promise<StoredCredentialSummary>;
  await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(
    "external-open:open",
    expect.objectContaining({ callerId: ctx.callerId }),
  ));
  const lastCall = emit.mock.calls[emit.mock.calls.length - 1]!;
  const authorizeUrl = new URL(lastCall[1].url);
  const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
  const state = authorizeUrl.searchParams.get("state");
  expect(redirectUri).toBeTruthy();
  expect(state).toBeTruthy();
  return { pending, authorizeUrl, redirectUri: redirectUri!, state: state! };
}

async function deliverOAuthCallback(redirectUri: string, params: URLSearchParams): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    http.get(`${redirectUri}?${params.toString()}`, (res) => {
      res.resume();
      res.on("end", resolve);
    }).on("error", reject);
  });
}

describe("credentialService", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stores, lists, and revokes URL-bound credentials without returning secrets", async () => {
    const store = new MemoryCredentialStore();
    const auditLog = new MemoryAuditLog();
    const service = createCredentialService({
      credentialStore: store as never,
      auditLog: auditLog as never,
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "worker:test",
          callerKind: "worker",
          repoPath: "/repo",
          effectiveVersion: "hash-1",
        }),
      },
    });

    const stored = await service.handler(
      { callerId: "worker:test", callerKind: "worker" },
      "storeCredential",
      [{
        label: "Example API",
        audience: [{ url: "https://API.example.com:443/v1?ignored=1", match: "path-prefix" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        material: { type: "bearer-token", token: "secret-token" },
        accountIdentity: { providerUserId: "acct-1" },
      }],
    ) as StoredCredentialSummary;

    expect(stored).toMatchObject({
      label: "Example API",
      audience: [{ url: "https://api.example.com/v1", match: "path-prefix" }],
      injection: { name: "authorization" },
      owner: { sourceId: "/repo", sourceKind: "workspace" },
    });
    expect(JSON.stringify(stored)).not.toContain("secret-token");

    const persisted = await store.loadUrlBound(stored.id);
    expect(persisted?.accessToken).toBe("secret-token");

    const listed = await service.handler(
      { callerId: "worker:test", callerKind: "worker" },
      "listStoredCredentials",
      [],
    ) as StoredCredentialSummary[];
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("secret-token");

    await service.handler(
      { callerId: "worker:test", callerKind: "worker" },
      "revokeCredential",
      [{ credentialId: stored.id }],
    );
    expect((await store.loadUrlBound(stored.id))?.revokedAt).toEqual(expect.any(Number));
    expect(auditLog.entries).toHaveLength(1);
  });

  it("stores privileged credential input without returning the submitted token", async () => {
    const store = new MemoryCredentialStore();
    const approvalQueue = {
      request: vi.fn(async () => "deny" as const),
      requestOAuthClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
      requestCredentialInput: vi.fn(async () => ({
        decision: "submit" as const,
        values: { token: "github_pat_secret" },
      })),
      resolve: vi.fn(),
      submitOAuthClientConfig: vi.fn(),
      submitCredentialInput: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
      sessionGrantStore: new CredentialSessionGrantStore(),
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "worker:test",
          callerKind: "worker",
          repoPath: "/repo",
          effectiveVersion: "hash-1",
        }),
      },
    });

    const stored = await service.handler(
      { callerId: "worker:test", callerKind: "worker" },
      "requestCredentialInput",
      [{
        title: "Add GitHub",
        credential: {
          label: "GitHub",
          audience: [{ url: "https://api.github.com/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
          accountIdentity: { providerUserId: "github-pat" },
          metadata: { providerId: "github" },
        },
        fields: [
          { name: "token", label: "Fine-grained PAT", type: "secret", required: true },
        ],
        material: { type: "bearer-token", tokenField: "token" },
      }],
    ) as StoredCredentialSummary;

    expect(stored).toMatchObject({
      label: "GitHub",
      metadata: expect.objectContaining({ providerId: "github" }),
    });
    expect(JSON.stringify(stored)).not.toContain("github_pat_secret");
    expect((await store.loadUrlBound(stored.id))?.accessToken).toBe("github_pat_secret");
    expect(approvalQueue.requestCredentialInput).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "credential-input",
        credentialLabel: "GitHub",
        repoPath: "/repo",
        effectiveVersion: "hash-1",
      })
    );
    expect(approvalQueue.request).not.toHaveBeenCalled();
  });

  it("only accepts one required secret field for privileged credential input", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "deny" as const),
      requestOAuthClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
      requestCredentialInput: vi.fn(async () => ({
        decision: "submit" as const,
        values: { token: "github_pat_secret" },
      })),
      resolve: vi.fn(),
      submitOAuthClientConfig: vi.fn(),
      submitCredentialInput: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      approvalQueue: approvalQueue as never,
      sessionGrantStore: new CredentialSessionGrantStore(),
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "worker:test",
          callerKind: "worker",
          repoPath: "/repo",
          effectiveVersion: "hash-1",
        }),
      },
    });
    const baseRequest = {
      title: "Add GitHub",
      credential: {
        label: "GitHub",
        audience: [{ url: "https://api.github.com/", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
      fields: [
        { name: "token", label: "Fine-grained PAT", type: "secret", required: true },
      ],
      material: { type: "bearer-token", tokenField: "token" },
    };
    const ctx = { callerId: "worker:test", callerKind: "worker" as const };

    await expect(service.handler(ctx, "requestCredentialInput", [{
      ...baseRequest,
      fields: [
        ...baseRequest.fields,
        { name: "username", label: "Username", type: "text", required: true },
      ],
    }])).rejects.toThrow("Credential input expects exactly one secret field");

    await expect(service.handler(ctx, "requestCredentialInput", [{
      ...baseRequest,
      fields: [{ name: "token", label: "Token", type: "text", required: true }],
    }])).rejects.toThrow("Credential input tokenField must be a secret field");

    expect(approvalQueue.requestCredentialInput).not.toHaveBeenCalled();
  });

  it("rejects credential revocation from callers without owner or grant access", async () => {
    const store = new MemoryCredentialStore();
    const service = createCredentialService({
      credentialStore: store as never,
      codeIdentityResolver: {
        resolveByCallerId: (callerId: string) => callerId === "worker:owner"
          ? { callerId, callerKind: "worker", repoPath: "/owner", effectiveVersion: "hash-1" }
          : { callerId, callerKind: "worker", repoPath: "/other", effectiveVersion: "hash-2" },
      },
    });

    const stored = await service.handler(
      { callerId: "worker:owner", callerKind: "worker" },
      "storeCredential",
      [{
        label: "Example API",
        audience: [{ url: "https://api.example.test/", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        material: { type: "bearer-token", token: "secret-token" },
      }],
    ) as StoredCredentialSummary;

    await expect(service.handler(
      { callerId: "worker:other", callerKind: "worker" },
      "revokeCredential",
      [{ credentialId: stored.id }],
    )).rejects.toThrow(/not authorized to revoke/);

    expect((await store.loadUrlBound(stored.id))?.revokedAt).toBeUndefined();
  });

  it("keeps session approvals process-local but stable across caller instances for the same version", async () => {
    const store = new MemoryCredentialStore();
    const approvalQueue = {
      request: vi.fn(async () => "session" as const),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
      sessionGrantStore: new CredentialSessionGrantStore(),
      codeIdentityResolver: {
        resolveByCallerId: (callerId: string) => {
          if (callerId === "worker:first" || callerId === "do:worker:first") {
            return { callerId, callerKind: "worker", repoPath: "/agent", effectiveVersion: "hash-1" };
          }
          if (callerId === "worker:new-version") {
            return { callerId, callerKind: "worker", repoPath: "/agent", effectiveVersion: "hash-2" };
          }
          return null;
        },
      },
    });

    const stored = await service.handler(
      { callerId: "worker:first", callerKind: "worker" },
      "storeCredential",
      [{
        label: "Example API",
        audience: [{ url: "https://api.example.test/", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        material: { type: "bearer-token", token: "secret-token" },
      }],
    ) as StoredCredentialSummary;

    expect((await store.loadUrlBound(stored.id))?.grants).toEqual([]);
    approvalQueue.request.mockClear();

    await expect(service.handler(
      { callerId: "do:worker:first", callerKind: "worker" },
      "resolveCredential",
      [{ url: "https://api.example.test/v1" }],
    )).resolves.toMatchObject({ id: stored.id });
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);

    await service.handler(
      { callerId: "worker:new-version", callerKind: "worker" },
      "resolveCredential",
      [{ url: "https://api.example.test/v1" }],
    );
    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
  });

  it("does not persist allow-once credential access approvals", async () => {
    const store = new MemoryCredentialStore();
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
      sessionGrantStore: new CredentialSessionGrantStore(),
      codeIdentityResolver: {
        resolveByCallerId: (callerId: string) => callerId === "worker:owner"
          ? { callerId, callerKind: "worker", repoPath: "/owner", effectiveVersion: "hash-1" }
          : { callerId, callerKind: "worker", repoPath: "/consumer", effectiveVersion: "hash-1" },
      },
    });

    const stored = await service.handler(
      { callerId: "worker:owner", callerKind: "worker" },
      "storeCredential",
      [{
        label: "Example API",
        audience: [{ url: "https://api.example.test/", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        material: { type: "bearer-token", token: "secret-token" },
      }],
    ) as StoredCredentialSummary;
    approvalQueue.request.mockClear();

    await service.handler(
      { callerId: "worker:consumer", callerKind: "worker" },
      "resolveCredential",
      [{ url: "https://api.example.test/v1" }],
    );
    await service.handler(
      { callerId: "worker:consumer", callerKind: "worker" },
      "resolveCredential",
      [{ url: "https://api.example.test/v1" }],
    );

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect((await store.loadUrlBound(stored.id))?.grants).toEqual([]);
  });

  it.each(["version", "repo"] as const)("reuses %s credential access grants", async (decision) => {
    const store = new MemoryCredentialStore();
    const approvalQueue = {
      request: vi.fn(async () => decision),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
      sessionGrantStore: new CredentialSessionGrantStore(),
      codeIdentityResolver: {
        resolveByCallerId: (callerId: string) => callerId === "worker:owner"
          ? { callerId, callerKind: "worker", repoPath: "/owner", effectiveVersion: "hash-1" }
          : { callerId, callerKind: "worker", repoPath: "/consumer", effectiveVersion: "hash-1" },
      },
    });

    const stored = await service.handler(
      { callerId: "worker:owner", callerKind: "worker" },
      "storeCredential",
      [{
        label: "Example API",
        audience: [{ url: "https://api.example.test/", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        material: { type: "bearer-token", token: "secret-token" },
      }],
    ) as StoredCredentialSummary;
    approvalQueue.request.mockClear();

    await service.handler(
      { callerId: "worker:consumer", callerKind: "worker" },
      "resolveCredential",
      [{ url: "https://api.example.test/v1" }],
    );
    await service.handler(
      { callerId: "worker:consumer", callerKind: "worker" },
      "resolveCredential",
      [{ url: "https://api.example.test/v1" }],
    );

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect((await store.loadUrlBound(stored.id))?.grants).toContainEqual(
      expect.objectContaining({
        bindingId: "fetch",
        use: "fetch",
        resource: "https://api.example.test/",
        action: "use",
        scope: decision,
        repoPath: "/consumer",
        grantedBy: decision,
      }),
    );
  });

  it("creates URL-bound credentials through generic OAuth PKCE and discards refresh tokens", async () => {
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue("version") as never,
    });
    const ctx = { callerId: "panel:test", callerKind: "panel" as const };

    const started = await startOAuthConnection(service, emit, ctx, {
      oauth: {
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
        scopes: ["read", "write"],
        extraAuthorizeParams: { prompt: "consent" },
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test/v1", match: "path-prefix" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        accountIdentity: { email: "dev@example.test" },
      },
    });

    const authorizeUrl = started.authorizeUrl;
    expect(authorizeUrl.searchParams.get("response_type")).toBe("code");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("client-1");
    expect(authorizeUrl.searchParams.get("scope")).toBe("read write");
    expect(authorizeUrl.searchParams.get("state")).toBe(started.state);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("prompt")).toBe("consent");

    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      const body = init?.body as URLSearchParams;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe("client-1");
      expect(body.get("code_verifier")).toBeTruthy();
      return new Response(JSON.stringify({
        access_token: "oauth-access-token",
        refresh_token: "must-not-persist",
        token_type: "Bearer",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    await deliverOAuthCallback(started.redirectUri, new URLSearchParams({
      code: "code-1",
      state: started.state,
    }));
    const completed = await started.pending;

    expect(completed).toMatchObject({
      label: "Example OAuth",
      accountIdentity: { email: "dev@example.test", providerUserId: "dev@example.test" },
      scopes: ["read", "write"],
    });
    expect(completed.expiresAt).toBeGreaterThan(Date.now());
    expect(JSON.stringify(completed)).not.toContain("oauth-access-token");

    const persisted = await store.loadUrlBound(completed.id);
    expect(persisted?.accessToken).toBe("oauth-access-token");
    expect(persisted?.grants).toEqual([
      expect.objectContaining({
        bindingId: "fetch",
        use: "fetch",
        resource: "https://api.example.test/v1",
        action: "use",
        scope: "version",
        repoPath: "panel:test",
        effectiveVersion: "unknown",
        grantedBy: "version",
      }),
    ]);
    expect(JSON.stringify(persisted)).not.toContain("must-not-persist");
  });

  it("connectOAuth owns browser handoff, callback validation, token exchange, and initial grant", async () => {
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const approvalQueue = {
      request: vi.fn(async () => "session" as const),
      requestOAuthClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
      requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
      resolve: vi.fn(),
      submitOAuthClientConfig: vi.fn(),
      submitCredentialInput: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvalQueue as never,
    });
    const ctx = { callerId: "panel:test", callerKind: "panel" as const };
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
      return new Response(JSON.stringify({
        access_token: "oauth-access-token",
        refresh_token: "must-not-persist",
        token_type: "Bearer",
        expires_in: 3600,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }));

    const pending = service.handler(ctx, "connectOAuth", [{
      oauth: {
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
        scopes: ["read"],
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test/", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
    }]) as Promise<StoredCredentialSummary>;

    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(
      "external-open:open",
      expect.objectContaining({ callerId: "panel:test" }),
    ));
    const authorizeUrl = new URL(emit.mock.calls[0]![1].url);
    const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
    const state = authorizeUrl.searchParams.get("state");
    expect(redirectUri).toBeTruthy();
    expect(state).toBeTruthy();
    await new Promise<void>((resolve, reject) => {
      http.get(`${redirectUri}?code=code-1&state=${state}`, (res) => {
        res.resume();
        res.on("end", resolve);
      }).on("error", reject);
    });

    const completed = await pending;
    expect(completed.label).toBe("Example OAuth");
    expect((await store.loadUrlBound(completed.id))?.accessToken).toBe("oauth-access-token");
    expect(JSON.stringify(await store.loadUrlBound(completed.id))).not.toContain("must-not-persist");
    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      credentialLabel: "Example OAuth",
      oauthAuthorizeOrigin: "https://auth.example.test",
      oauthTokenOrigin: "https://auth.example.test",
    }));
  });

  it("connectOAuth can open OAuth externally for a worker-requested panel handoff", async () => {
    const emit = vi.fn();
    const eventService = targetedOpenEventService(emit);
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: eventService as never,
      tokenManager: { getPanelOwner: vi.fn(() => "shell:owner") } as never,
      approvalQueue: approvingQueue() as never,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "token",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const pending = service.handler({ callerId: "worker:test", callerKind: "worker" }, "connectOAuth", [{
      spec: {
        oauth: {
          authorizeUrl: "https://auth.example.test/oauth/authorize",
          tokenUrl: "https://auth.example.test/oauth/token",
          clientId: "client-1",
        },
        credential: {
          label: "Example OAuth",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        },
        browser: "external",
      },
      handoffTarget: {
        callerId: "panel:test",
        callerKind: "panel",
      },
    }]) as Promise<StoredCredentialSummary>;

    await vi.waitFor(() => expect(eventService.emitTo).toHaveBeenCalledWith(
      "shell:owner",
      "external-open:open",
      expect.objectContaining({
        callerId: "worker:test",
        callerKind: "worker",
      }),
    ));
    const authorizeUrl = new URL(emit.mock.calls[0]![1].url);
    await deliverOAuthCallback(authorizeUrl.searchParams.get("redirect_uri")!, new URLSearchParams({
      code: "code-1",
      state: authorizeUrl.searchParams.get("state")!,
    }));
    await pending;
  });

  it("connectOAuth can open OAuth in an internal browser panel for a worker-requested panel handoff", async () => {
    const emit = vi.fn();
    const eventService = targetedOpenEventService(emit);
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: eventService as never,
      tokenManager: { getPanelOwner: vi.fn(() => "shell:owner") } as never,
      approvalQueue: approvingQueue() as never,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "token",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const pending = service.handler({ callerId: "worker:test", callerKind: "worker" }, "connectOAuth", [{
      spec: {
        oauth: {
          authorizeUrl: "https://auth.example.test/oauth/authorize",
          tokenUrl: "https://auth.example.test/oauth/token",
          clientId: "client-1",
        },
        credential: {
          label: "Example OAuth",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        },
        browser: "internal",
      },
      handoffTarget: {
        callerId: "panel:test",
        callerKind: "panel",
      },
    }]) as Promise<StoredCredentialSummary>;

    await vi.waitFor(() => expect(eventService.emitTo).toHaveBeenCalledWith(
      "shell:owner",
      "browser-panel:open",
      expect.objectContaining({
        parentPanelId: "panel:test",
        callerId: "worker:test",
        callerKind: "worker",
      }),
    ));
    const authorizeUrl = new URL(emit.mock.calls[0]![1].url);
    await deliverOAuthCallback(authorizeUrl.searchParams.get("redirect_uri")!, new URLSearchParams({
      code: "code-1",
      state: authorizeUrl.searchParams.get("state")!,
    }));
    await pending;
  });

  it("fails immediately when the OAuth browser handoff target is not connected", async () => {
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: {
        emit: vi.fn(),
        emitTo: vi.fn(() => false),
      } as never,
      approvalQueue: approvingQueue() as never,
    });

    await expect(service.handler({ callerId: "worker:test", callerKind: "worker" }, "connectOAuth", [{
      spec: {
        oauth: {
          authorizeUrl: "https://auth.example.test/oauth/authorize",
          tokenUrl: "https://auth.example.test/oauth/token",
          clientId: "client-1",
        },
        credential: {
          label: "Example OAuth",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        },
      },
      handoffTarget: {
        callerId: "panel:missing",
        callerKind: "panel",
      },
    }])).rejects.toMatchObject({ code: "browser_unavailable" });
  });

  it("fails immediately when a panel handoff has no connected shell owner", async () => {
    const emitTo = vi.fn(() => true);
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: {
        emit: vi.fn(),
        emitTo,
      } as never,
      tokenManager: { getPanelOwner: vi.fn(() => undefined) } as never,
      approvalQueue: approvingQueue() as never,
    });

    await expect(service.handler({ callerId: "worker:test", callerKind: "worker" }, "connectOAuth", [{
      spec: {
        oauth: {
          authorizeUrl: "https://auth.example.test/oauth/authorize",
          tokenUrl: "https://auth.example.test/oauth/token",
          clientId: "client-1",
        },
        credential: {
          label: "Example OAuth",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        },
      },
      handoffTarget: {
        callerId: "panel:missing-owner",
        callerKind: "panel",
      },
    }])).rejects.toMatchObject({ code: "browser_unavailable" });
    expect(emitTo).not.toHaveBeenCalled();
  });

  it("supports authenticated client-forwarded mobile callbacks by state", async () => {
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "token",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const pending = service.handler({ callerId: "shell", callerKind: "shell" }, "connectOAuth", [{
      oauth: {
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test/", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
      redirect: {
        type: "client-forwarded",
        callbackUri: "https://auth.snugenv.com/oauth/callback/example",
      },
    }]) as Promise<StoredCredentialSummary>;

    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith(
      "external-open:open",
      expect.objectContaining({ callerId: "shell" }),
    ));
    const authorizeUrl = new URL(emit.mock.calls[0]![1].url);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe("https://auth.snugenv.com/oauth/callback/example");
    const state = authorizeUrl.searchParams.get("state")!;

    await service.handler({ callerId: "shell", callerKind: "shell" }, "forwardOAuthCallback", [{
      url: `https://auth.snugenv.com/oauth/callback/example?code=code-1&state=${state}`,
    }]);

    await expect(pending).resolves.toMatchObject({ label: "Example OAuth" });
  });

  it("rejects forwarded OAuth callbacks that do not match the bound redirect URI", async () => {
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });

    const pending = service.handler({ callerId: "shell", callerKind: "shell" }, "connectOAuth", [{
      oauth: {
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test/", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
      redirect: {
        type: "client-forwarded",
        callbackUri: "https://auth.snugenv.com/oauth/callback/example",
      },
    }]) as Promise<StoredCredentialSummary>;

    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    const state = new URL(emit.mock.calls[0]![1].url).searchParams.get("state")!;
    await service.handler({ callerId: "shell", callerKind: "shell" }, "forwardOAuthCallback", [{
      url: `https://evil.example.test/oauth/callback/example?code=code-1&state=${state}`,
    }]);

    await expect(pending).rejects.toMatchObject({ code: "redirect_mismatch" });
  });

  it("rejects public OAuth specs that include private browser handoff routing", async () => {
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: targetedOpenEventService(vi.fn()) as never,
      approvalQueue: approvingQueue() as never,
    });

    await expect(service.handler({ callerId: "panel:test", callerKind: "panel" }, "connectOAuth", [{
      oauth: {
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test/", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
      browserHandoff: {
        openMode: "external",
        targetCallerId: "panel:other",
        targetCallerKind: "panel",
      },
    }])).rejects.toThrow();
  });

  it("rejects panel callers that try to use the internal handoff envelope", async () => {
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: targetedOpenEventService(vi.fn()) as never,
      approvalQueue: approvingQueue() as never,
    });

    await expect(service.handler({ callerId: "panel:test", callerKind: "panel" }, "connectOAuth", [{
      spec: {
        oauth: {
          authorizeUrl: "https://auth.example.test/oauth/authorize",
          tokenUrl: "https://auth.example.test/oauth/token",
          clientId: "client-1",
        },
        credential: {
          label: "Example OAuth",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        },
      },
      handoffTarget: {
        callerId: "panel:other",
        callerKind: "panel",
      },
    }])).rejects.toMatchObject({ code: "client_not_authorized" });
  });

  it("surfaces sanitized OAuth token endpoint error details", async () => {
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });
    const ctx = { callerId: "panel:test", callerKind: "panel" as const };
    const started = await startOAuthConnection(service, emit, ctx, {
      oauth: {
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      error: "invalid_client",
      error_description: "Unauthorized",
      refresh_token: "must-not-leak",
    }), { status: 400, headers: { "content-type": "application/json" } })));

    const pendingError: Promise<Error> = started.pending.then(
      () => { throw new Error("expected OAuth connection to fail"); },
      (error: Error) => error,
    );
    await deliverOAuthCallback(started.redirectUri, new URLSearchParams({
      code: "code-1",
      state: started.state,
    }));
    expect((await pendingError).message).toBe("OAuth token exchange failed: 400 invalid_client: Unauthorized");
  });

  it("maps provider-denied OAuth callbacks to approval_denied", async () => {
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });
    const ctx = { callerId: "panel:test", callerKind: "panel" as const };
    const started = await startOAuthConnection(service, emit, ctx, {
      oauth: {
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
    });

    const pendingError: Promise<Error> = started.pending.then(
      () => { throw new Error("expected OAuth connection to fail"); },
      (error: Error) => error,
    );
    await deliverOAuthCallback(started.redirectUri, new URLSearchParams({
      error: "access_denied",
      state: started.state,
    }));

    await expect(pendingError).resolves.toMatchObject({ code: "approval_denied" });
  });

  it("stores URL-bound OAuth client config from approval UI without returning secret values", async () => {
    const oauthClientConfigStore = new MemoryOAuthClientConfigStore();
    const approvalQueue = {
      request: vi.fn(),
      requestOAuthClientConfig: vi.fn(async () => ({
        decision: "submit" as const,
        values: {
          clientId: "client-1",
          clientSecret: "secret-1",
        },
      })),
      requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
      resolve: vi.fn(),
      submitOAuthClientConfig: vi.fn(),
      submitCredentialInput: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      oauthClientConfigStore: oauthClientConfigStore as never,
      approvalQueue: approvalQueue as never,
    });
    const ctx = { callerId: "panel:test", callerKind: "panel" as const };

    const status = await service.handler(ctx, "configureOAuthClient", [{
      configId: "google-workspace",
      title: "Configure Google Workspace OAuth",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      fields: [
        { name: "clientId", label: "Client ID", type: "text", required: true },
        { name: "clientSecret", label: "Client secret", type: "secret", required: true },
      ],
    }]);

    expect(status).toMatchObject({
      configId: "google-workspace",
      configured: true,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      fields: {
        clientId: { configured: true, type: "text" },
        clientSecret: { configured: true, type: "secret" },
      },
    });
    expect(JSON.stringify(status)).not.toContain("secret-1");
    expect((await oauthClientConfigStore.load("google-workspace"))?.fields["clientSecret"]?.value).toBe("secret-1");
  });

  it("authorizes OAuth client config status and prompts before deletion", async () => {
    const oauthClientConfigStore = new MemoryOAuthClientConfigStore();
    await oauthClientConfigStore.save({
      configId: "google-workspace",
      currentVersion: "v1",
      owner: {
        callerId: "panel:owner",
        callerKind: "panel",
        repoPath: "/repo",
        effectiveVersion: "hash-1",
      },
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      fields: {
        clientId: { value: "client-1", type: "text", updatedAt: 1 },
        clientSecret: { value: "secret-1", type: "secret", updatedAt: 1 },
      },
      versions: {},
      createdAt: 1,
      updatedAt: 1,
    });
    const approvalQueue = approvingQueue("once");
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      oauthClientConfigStore: oauthClientConfigStore as never,
      approvalQueue: approvalQueue as never,
      codeIdentityResolver: {
        resolveByCallerId: (callerId: string) => callerId === "panel:owner"
          ? { callerId, callerKind: "panel", repoPath: "/repo", effectiveVersion: "hash-1" }
          : { callerId, callerKind: "panel", repoPath: "/other", effectiveVersion: "hash-1" },
      },
    });

    await expect(service.handler(
      { callerId: "panel:other", callerKind: "panel" },
      "getOAuthClientConfigStatus",
      [{ configId: "google-workspace" }],
    )).rejects.toThrow("client_not_authorized");

    await service.handler(
      { callerId: "panel:owner", callerKind: "panel" },
      "deleteOAuthClientConfig",
      [{ configId: "google-workspace" }],
    );

    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      kind: "capability",
      capability: "oauth-client-config-delete",
      title: "Disable service configuration",
    }));
    expect(await oauthClientConfigStore.load("google-workspace")).toBeNull();
  });

  it("rejects OAuth client config URLs with fragments or token query parameters", async () => {
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      oauthClientConfigStore: new MemoryOAuthClientConfigStore() as never,
      approvalQueue: {
        request: vi.fn(),
        requestOAuthClientConfig: vi.fn(),
        requestCredentialInput: vi.fn(),
        resolve: vi.fn(),
        submitOAuthClientConfig: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => []),
      } as never,
    });
    const ctx = { callerId: "panel:test", callerKind: "panel" as const };
    const baseRequest = {
      configId: "google-workspace",
      title: "Configure Google Workspace OAuth",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      fields: [
        { name: "clientId", label: "Client ID", type: "text" as const, required: true },
        { name: "clientSecret", label: "Client secret", type: "secret" as const, required: true },
      ],
    };

    await expect(service.handler(ctx, "configureOAuthClient", [{
      ...baseRequest,
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth#frag",
    }])).rejects.toThrow("authorizeUrl must not include a fragment");
    await expect(service.handler(ctx, "configureOAuthClient", [{
      ...baseRequest,
      tokenUrl: "https://oauth2.googleapis.com/token?client_secret=inline",
    }])).rejects.toThrow("tokenUrl must not include query parameters");
    await expect(service.handler(ctx, "configureOAuthClient", [{
      ...baseRequest,
      tokenUrl: "https://oauth2.googleapis.com/token#frag",
    }])).rejects.toThrow("tokenUrl must not include a fragment");
  });

  it("builds URL-bound OAuth client config PKCE without exposing client secrets in userland request", async () => {
    const oauthClientConfigStore = new MemoryOAuthClientConfigStore();
    await oauthClientConfigStore.save({
      configId: "google-workspace",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      fields: {
        clientId: { value: "client-1", type: "text", updatedAt: 1 },
        clientSecret: { value: "secret-1", type: "secret", updatedAt: 1 },
      },
      createdAt: 1,
      updatedAt: 1,
    });
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      oauthClientConfigStore: oauthClientConfigStore as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });
    const ctx = { callerId: "panel:test", callerKind: "panel" as const };

    const started = await startOAuthConnection(service, emit, ctx, {
      oauth: {
        clientConfigId: "google-workspace",
        scopes: ["scope-1"],
        extraAuthorizeParams: {
          access_type: "offline",
          prompt: "consent",
        },
      },
      credential: {
        label: "Google Workspace",
        audience: [{ url: "https://www.googleapis.com/", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
    });

    const authorizeUrl = started.authorizeUrl;
    expect(authorizeUrl.searchParams.get("client_id")).toBe("client-1");
    expect(authorizeUrl.searchParams.get("client_secret")).toBeNull();
    expect(authorizeUrl.searchParams.get("access_type")).toBe("offline");

    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body as URLSearchParams;
      expect(body.get("client_id")).toBe("client-1");
      expect(body.get("client_secret")).toBe("secret-1");
      return new Response(JSON.stringify({
        access_token: "token",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await deliverOAuthCallback(started.redirectUri, new URLSearchParams({
      code: "code-1",
      state: started.state,
    }));
    await started.pending;
  });

  it("rejects OAuth client config updates that try to change URL bindings", async () => {
    const oauthClientConfigStore = new MemoryOAuthClientConfigStore();
    await oauthClientConfigStore.save({
      configId: "google-workspace",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      fields: {
        clientId: { value: "client-1", type: "text", updatedAt: 1 },
        clientSecret: { value: "secret-1", type: "secret", updatedAt: 1 },
      },
      createdAt: 1,
      updatedAt: 1,
    });
    const approvalQueue = {
      request: vi.fn(),
      requestOAuthClientConfig: vi.fn(async () => ({
        decision: "submit" as const,
        values: {
          clientId: "client-2",
          clientSecret: "secret-2",
        },
      })),
      requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
      resolve: vi.fn(),
      submitOAuthClientConfig: vi.fn(),
      submitCredentialInput: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      oauthClientConfigStore: oauthClientConfigStore as never,
      approvalQueue: approvalQueue as never,
    });

    await expect(service.handler({ callerId: "panel:test", callerKind: "panel" as const }, "configureOAuthClient", [{
      configId: "google-workspace",
      title: "Configure Google Workspace OAuth",
      authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://evil.example.test/token",
      fields: [
        { name: "clientId", label: "Client ID", type: "text", required: true },
        { name: "clientSecret", label: "Client secret", type: "secret", required: true },
      ],
    }])).rejects.toThrow("tokenUrl is immutable");
  });

  it("surfaces OAuth origins and domain mismatch in credential approval requests", async () => {
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const approvalQueue = {
      request: vi.fn(async () => "session" as const),
      requestOAuthClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
      requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
      resolve: vi.fn(),
      submitOAuthClientConfig: vi.fn(),
      submitCredentialInput: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvalQueue as never,
    });
    const ctx = { callerId: "panel:test", callerKind: "panel" as const };

    const started = await startOAuthConnection(service, emit, ctx, {
      oauth: {
        authorizeUrl: "https://accounts.example-login.test/oauth/authorize",
        tokenUrl: "https://accounts.example-login.test/oauth/token",
        clientId: "client-1",
        allowMissingExpiry: true,
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "token",
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await deliverOAuthCallback(started.redirectUri, new URLSearchParams({
      code: "code-1",
      state: started.state,
    }));
    await started.pending;

    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      oauthAuthorizeOrigin: "https://accounts.example-login.test",
      oauthTokenOrigin: "https://accounts.example-login.test",
      oauthAudienceDomainMismatch: true,
    }));
  });

  it("rejects OAuth extra authorize params that override host-controlled PKCE fields", async () => {
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: targetedOpenEventService(vi.fn()) as never,
      approvalQueue: approvingQueue() as never,
    });
    const ctx = { callerId: "panel:test", callerKind: "panel" as const };

    await expect(service.handler(ctx, "connectOAuth", [{
      oauth: {
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
        extraAuthorizeParams: { state: "attacker" },
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
    }])).rejects.toThrow(/cannot override state/);
  });

  it("accepts OAuth token responses that omit token_type", async () => {
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });
    const ctx = { callerId: "panel:test", callerKind: "panel" as const };
    const started = await startOAuthConnection(service, emit, ctx, {
      oauth: {
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "token",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await deliverOAuthCallback(started.redirectUri, new URLSearchParams({
      code: "code-1",
      state: started.state,
    }));
    const completed = await started.pending;

    expect((await store.loadUrlBound(completed.id))?.accessToken).toBe("token");
  });

  it("can derive OAuth account identity from an access-token JWT claim", async () => {
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });
    const ctx = { callerId: "panel:test", callerKind: "panel" as const };
    const started = await startOAuthConnection(service, emit, ctx, {
      oauth: {
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        metadata: {
          oauthAccountIdentityJwtClaimRoot: "https://api.example.test/auth",
          oauthAccountIdentityJwtClaimField: "account_id",
        },
      },
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: jwtWithPayload({
        "https://api.example.test/auth": { account_id: "acct-from-token" },
      }),
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } })));

    await deliverOAuthCallback(started.redirectUri, new URLSearchParams({
      code: "code-1",
      state: started.state,
    }));
    const completed = await started.pending;

    expect(completed.accountIdentity?.providerUserId).toBe("acct-from-token");
  });

  it("validates OAuth account identity through declarative userinfo fetch", async () => {
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });
    const ctx = { callerId: "panel:test", callerKind: "panel" as const };
    const started = await startOAuthConnection(service, emit, ctx, {
      oauth: {
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
        accountValidation: {
          userinfo: {
            url: "https://auth.example.test/userinfo",
            idField: "sub",
            emailField: "email",
          },
        },
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
    });

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === "https://auth.example.test/userinfo") {
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
        return new Response(JSON.stringify({ sub: "acct-userinfo", email: "dev@example.test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        access_token: "token",
        expires_in: 3600,
      }), { status: 200, headers: { "content-type": "application/json" } });
    }));

    await deliverOAuthCallback(started.redirectUri, new URLSearchParams({
      code: "code-1",
      state: started.state,
    }));
    const completed = await started.pending;

    expect(completed.accountIdentity).toMatchObject({
      providerUserId: "acct-userinfo",
      email: "dev@example.test",
    });
  });

  it("rejects OAuth callback state and non-bearer token responses", async () => {
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });
    const ctx = { callerId: "panel:test", callerKind: "panel" as const };
    const started = await startOAuthConnection(service, emit, ctx, {
      oauth: {
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
    });

    const stateError: Promise<Error> = started.pending.then(
      () => { throw new Error("expected OAuth connection to fail"); },
      (error: Error) => error,
    );
    await deliverOAuthCallback(started.redirectUri, new URLSearchParams({
      code: "code-1",
      state: "wrong",
    })).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET" && !/ECONNRESET/.test(error.message)) throw error;
    });
    expect((await stateError).message).toMatch(/state_mismatch/);

    emit.mockClear();
    const started2 = await startOAuthConnection(service, emit, ctx, {
      oauth: {
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
    });

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      access_token: "token",
      token_type: "mac",
      expires_in: 3600,
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const tokenTypeError: Promise<Error> = started2.pending.then(
      () => { throw new Error("expected OAuth connection to fail"); },
      (error: Error) => error,
    );
    await deliverOAuthCallback(started2.redirectUri, new URLSearchParams({
      code: "code-1",
      state: started2.state,
    })).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET" && !/ECONNRESET/.test(error.message)) throw error;
    });
    expect((await tokenTypeError).message).toMatch(/bearer token_type/);
  });

  it("returns only egress audit entries from audit queries", async () => {
    const auditLog = new MemoryAuditLog();
    auditLog.entries.push(
      {
        type: "connection_credential.created",
        ts: 1,
        callerId: "worker:test",
        providerId: "url-bound",
        connectionId: "cred-1",
        storageKind: "connection-credential",
        fieldNames: ["credential"],
      },
      {
        ts: 2,
        workerId: "/repo",
        callerId: "worker:test",
        providerId: "url-bound",
        connectionId: "cred-1",
        method: "GET",
        url: "https://api.example.test/",
        status: 200,
        durationMs: 1,
        bytesIn: 0,
        bytesOut: 0,
        scopesUsed: [],
        retries: 0,
        breakerState: "closed",
      } satisfies AuditEntry,
    );
    const service = createCredentialService({ auditLog: auditLog as never });
    const entries = await service.handler(
      { callerId: "shell", callerKind: "shell" },
      "audit",
      [{}],
    ) as AuditEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.method).toBe("GET");
  });
});
