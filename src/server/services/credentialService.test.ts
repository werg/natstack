import { createVerifiedCaller } from "@natstack/shared/serviceDispatcher";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as http from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { chatMessagesFromChannelView } from "@workspace/agentic-core";
import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  CREDENTIAL_CONNECT_PAYLOAD_KIND,
  brandId,
  createInitialChannelViewState,
  reduceChannelView,
  type AgenticEvent,
  type BlockId,
  type ChannelEnvelope,
  type ChannelId,
  type EnvelopeId,
  type MessageId,
  type TurnId,
} from "@workspace/agentic-protocol";

import type {
  AuditEntry,
  Credential,
  CredentialAuditEvent,
  ManagedCredentialSummary,
  CredentialUseGrant,
  StoredCredentialSummary,
} from "../../../packages/shared/src/credentials/types.js";
import type { ClientConfigRecord } from "../../../packages/shared/src/credentials/clientConfigStore.js";
import { createCredentialService } from "./credentialService.js";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import { DEFERRED_RESULT, isDeferredResult } from "@natstack/shared/serviceDispatcher";
import { CredentialSessionGrantStore } from "./credentialSessionGrants.js";
import { createApprovalQueue } from "./approvalQueue.js";

function verifiedTestCaller(
  callerId: string,
  callerKind: "app" | "panel" | "worker" | "do" | "shell"
) {
  if (callerKind !== "panel" && callerKind !== "worker") {
    if (callerKind !== "do") {
      return createVerifiedCaller(callerId, callerKind);
    }
  }
  const suffix = callerId.startsWith("panel-")
    ? callerId.slice("panel-".length)
    : (callerId.split(":").pop() ?? callerId);
  const repoPath =
    suffix === "test"
      ? "/repo"
      : suffix === "owner" && callerKind === "panel"
        ? "/repo"
        : suffix === "owner" || suffix === "first"
          ? "/owner"
          : suffix === "other"
            ? "/other"
            : suffix === "consumer"
              ? "/consumer"
              : callerId.startsWith("do:")
                ? "/owner"
                : `/${suffix}`;
  const effectiveVersion = suffix === "other" || suffix === "new-version" ? "hash-2" : "hash-1";
  return createVerifiedCaller(callerId, callerKind, {
    callerId,
    callerKind: callerKind === "do" ? "do" : callerKind,
    repoPath,
    effectiveVersion,
  });
}

function authorizingShellLookup(connectionId = "owner-conn") {
  return {
    getAuthorizingShell: vi.fn(() => ({
      caller: { runtime: { id: "shell:owner", kind: "shell" } },
      connectionId,
    })),
  };
}

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
    return [...this.credentials.values()].filter(
      (credential) => credential.providerId === "url-bound"
    );
  }

  async remove(providerId: string, connectionId: string): Promise<void> {
    this.credentials.delete(`${providerId}:${connectionId}`);
  }

  async removeUrlBound(id: string): Promise<void> {
    this.credentials.delete(`url-bound:${id}`);
  }
}

class MemoryCredentialUseGrantStore {
  private readonly grants: Array<CredentialUseGrant & { credentialId: string }> = [];

  list(credentialId: string): CredentialUseGrant[] {
    return this.grants
      .filter((grant) => grant.credentialId === credentialId)
      .map(({ credentialId: _credentialId, ...grant }) => ({ ...grant }));
  }

  upsert(credentialId: string, grant: CredentialUseGrant): void {
    const key = [
      credentialId,
      grant.bindingId,
      grant.use,
      grant.resource,
      grant.action,
      grant.scope,
      grant.callerId ?? "",
      grant.repoPath ?? "",
      grant.effectiveVersion ?? "",
    ].join("\x00");
    const index = this.grants.findIndex(
      (entry) =>
        [
          entry.credentialId,
          entry.bindingId,
          entry.use,
          entry.resource,
          entry.action,
          entry.scope,
          entry.callerId ?? "",
          entry.repoPath ?? "",
          entry.effectiveVersion ?? "",
        ].join("\x00") === key
    );
    if (index >= 0) this.grants.splice(index, 1);
    this.grants.push({ credentialId, ...grant });
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

class MemoryClientConfigStore {
  private readonly records = new Map<string, ClientConfigRecord>();

  async save(record: ClientConfigRecord): Promise<void> {
    this.records.set(record.configId, record);
  }

  async load(configId: string): Promise<ClientConfigRecord | null> {
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
    record: ClientConfigRecord | null,
    requestedFields?: readonly { name: string; type: "text" | "secret" }[]
  ) {
    const fields: Record<
      string,
      { configured: boolean; type: "text" | "secret"; updatedAt?: number }
    > = {};
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
  return ["header", Buffer.from(JSON.stringify(payload)).toString("base64url"), "signature"].join(
    "."
  );
}

function approvingQueue(decision: "once" | "session" | "version" | "repo" | "deny" = "version") {
  return {
    request: vi.fn(async () => decision),
    requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
    requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
    requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
    requestUserland: vi.fn(async () => ({ kind: "dismissed" as const })),
    presentDeviceCode: vi.fn((_req: unknown) => ({
      approvalId: "device-code-test",
      cancelled: new AbortController().signal,
      dispose: vi.fn(),
    })),
    resolve: vi.fn(),
    resolveUserland: vi.fn(),
    submitClientConfig: vi.fn(),
    submitSecretInput: vi.fn(),
    submitCredentialInput: vi.fn(),
    listPending: vi.fn(() => []),
  };
}

function targetedOpenEventService(emit: ReturnType<typeof vi.fn>) {
  return {
    emit,
    emitToCaller: vi.fn((callerId: string, event: string, payload: unknown) => {
      emit(event, payload);
      return callerId.length > 0;
    }),
    emitToConnection: vi.fn(
      (callerId: string, _connectionId: string, event: string, payload: unknown) => {
        emit(event, payload);
        return callerId.length > 0;
      }
    ),
  };
}

async function startOAuthConnection(
  service: ReturnType<typeof createCredentialService>,
  emit: ReturnType<typeof vi.fn>,
  ctx: ServiceContext,
  request: unknown
) {
  // Round-trip OAuth tests deliver the callback to a server-local listener via
  // http.get(redirect_uri). The PRODUCTION default redirect is now the relay (§7,
  // unreachable in-process), so opt into the server-owned `loopback` redirect when
  // a test does not specify one — keeping the in-process callback round-trip valid.
  // Tests that assert a specific redirect (client-loopback / public-relay) pass
  // their own `spec.redirect` and are unaffected.
  const req = request as { redirect?: unknown; spec?: { redirect?: unknown } };
  if (req && typeof req === "object") {
    if (req.spec && typeof req.spec === "object") {
      if (req.spec.redirect === undefined) req.spec.redirect = { type: "loopback" };
    } else if (req.redirect === undefined) {
      req.redirect = { type: "loopback" };
    }
  }
  const pending = service.handler(ctx, "connect", [request]) as Promise<StoredCredentialSummary>;
  await vi.waitFor(() =>
    expect(emit).toHaveBeenCalledWith(
      "external-open:open",
      expect.objectContaining({ callerId: ctx.caller.runtime.id })
    )
  );
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
    http
      .get(`${redirectUri}?${params.toString()}`, (res) => {
        res.resume();
        res.on("end", resolve);
      })
      .on("error", reject);
  });
}

describe("credentialService", () => {
  // OAuth callbacks are now relay-hosted for every platform (plan §7); the
  // `public` default redirect_uri is built from this origin (buildRelayOAuthCallbackUrl).
  const ORIGINAL_RELAY = process.env["NATSTACK_RELAY_OAUTH_BASE_URL"];
  beforeEach(() => {
    process.env["NATSTACK_RELAY_OAUTH_BASE_URL"] = "https://relay.test";
  });
  afterEach(() => {
    if (ORIGINAL_RELAY === undefined) delete process.env["NATSTACK_RELAY_OAUTH_BASE_URL"];
    else process.env["NATSTACK_RELAY_OAUTH_BASE_URL"] = ORIGINAL_RELAY;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("stores, lists, and revokes URL-bound credentials without returning secrets", async () => {
    const store = new MemoryCredentialStore();
    const auditLog = new MemoryAuditLog();
    const approvalQueue = approvingQueue("once");
    const service = createCredentialService({
      credentialStore: store as never,
      auditLog: auditLog as never,
      approvalQueue: approvalQueue as never,
    });

    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "storeCredential",
      [
        {
          label: "Example API",
          audience: [{ url: "https://API.example.com:443/v1?ignored=1", match: "path-prefix" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
          material: { type: "bearer-token", token: "secret-token" },
          accountIdentity: { providerUserId: "acct-1" },
        },
      ]
    )) as StoredCredentialSummary;

    expect(stored).toMatchObject({
      label: "Example API",
      audience: [{ url: "https://api.example.com/v1", match: "path-prefix" }],
      injection: { name: "authorization" },
      owner: { sourceId: "/repo", sourceKind: "workspace" },
    });
    expect(JSON.stringify(stored)).not.toContain("secret-token");

    const persisted = await store.loadUrlBound(stored.id);
    expect(persisted?.accessToken).toBe("secret-token");

    const listed = (await service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "listStoredCredentials",
      []
    )) as StoredCredentialSummary[];
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("secret-token");

    const listedByOtherCaller = (await service.handler(
      { caller: verifiedTestCaller("worker:other", "worker") },
      "listStoredCredentials",
      []
    )) as StoredCredentialSummary[];
    expect(listedByOtherCaller).toHaveLength(1);
    expect(JSON.stringify(listedByOtherCaller)).not.toContain("secret-token");

    await service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "revokeCredential",
      [{ credentialId: stored.id }]
    );
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "capability",
        capability: "credential-revoke",
        callerId: "worker:test",
      })
    );
    expect((await store.loadUrlBound(stored.id))?.revokedAt).toEqual(expect.any(Number));
    expect(auditLog.entries).toHaveLength(1);
  });

  it("inspects persisted credential grants with focusable panel and worker subjects", async () => {
    const store = new MemoryCredentialStore();
    const grantedAt = Date.now();
    await store.saveUrlBound({
      id: "cred-1",
      label: "Example API",
      providerId: "url-bound",
      connectionId: "cred-1",
      connectionLabel: "Example API",
      accountIdentity: { providerUserId: "acct-1", username: "alice" },
      accessToken: "secret-token",
      scopes: ["read"],
      bindings: [
        {
          id: "fetch",
          label: "REST API",
          use: "fetch",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
        },
      ],
      grants: [
        {
          bindingId: "fetch",
          use: "fetch",
          resource: "https://api.example.test/",
          action: "use",
          scope: "version",
          repoPath: "/owner",
          effectiveVersion: "hash-1",
          grantedAt,
          grantedBy: "version",
        },
      ],
    });
    const resolvePanelSlotByEntity = vi.fn(async (entityId: string) =>
      entityId === "panel:owner" ? "panel:tree/owner" : null
    );
    const service = createCredentialService({
      credentialStore: store as never,
      runtimeInspector: {
        listActiveEntities: () => [
          {
            id: "panel:owner",
            kind: "panel",
            source: { repoPath: "/owner", effectiveVersion: "hash-1" },
            contextId: "ctx-owner",
            key: "owner",
            createdAt: grantedAt,
            status: "active",
            cleanupComplete: true,
          },
          {
            id: "worker:/owner:jobs",
            kind: "worker",
            source: { repoPath: "/owner", effectiveVersion: "hash-1" },
            contextId: "ctx-owner",
            key: "jobs",
            parentId: "panel:owner",
            createdAt: grantedAt,
            status: "active",
            cleanupComplete: true,
          },
          {
            id: "do:/owner:Agent:main",
            kind: "do",
            source: { repoPath: "/owner", effectiveVersion: "hash-1" },
            contextId: "ctx-owner",
            className: "Agent",
            key: "main",
            parentId: "worker:/owner:jobs",
            createdAt: grantedAt,
            status: "active",
            cleanupComplete: true,
          },
          {
            id: "worker:/owner:other-version",
            kind: "worker",
            source: { repoPath: "/owner", effectiveVersion: "hash-2" },
            contextId: "ctx-owner",
            key: "other-version",
            parentId: "panel:owner",
            createdAt: grantedAt,
            status: "active",
            cleanupComplete: true,
          },
        ],
        resolvePanelSlotByEntity,
        listPanels: () => [
          {
            panelId: "panel:tree/owner",
            title: "Owner Panel",
            source: "panels/owner",
            kind: "workspace",
            parentId: null,
            contextId: "ctx-owner",
            runtimeEntityId: "panel:owner",
            effectiveVersion: "hash-1",
          },
        ],
      },
    });

    const inspected = (await service.handler(
      { caller: verifiedTestCaller("worker:other", "worker") },
      "inspectStoredCredentials",
      []
    )) as ManagedCredentialSummary[];

    expect(JSON.stringify(inspected)).not.toContain("secret-token");
    expect(inspected).toHaveLength(1);
    expect(inspected[0]!.grants).toHaveLength(1);
    expect(inspected[0]!.grants[0]).toMatchObject({
      bindingId: "fetch",
      bindingLabel: "REST API",
      scope: "version",
      repoPath: "/owner",
      effectiveVersion: "hash-1",
      grantedAt,
    });
    expect(inspected[0]!.grants[0]!.subjects.map((subject) => subject.id)).toEqual([
      "panel:owner",
      "worker:/owner:jobs",
      "do:/owner:Agent:main",
    ]);
    expect(inspected[0]!.grants[0]!.subjects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "worker:/owner:jobs",
          kind: "worker",
          focusPanelId: "panel:tree/owner",
          focusPanelTitle: "Owner Panel",
        }),
        expect.objectContaining({
          id: "do:/owner:Agent:main",
          kind: "do",
          focusPanelId: "panel:tree/owner",
        }),
      ])
    );
    expect(resolvePanelSlotByEntity).not.toHaveBeenCalled();
  });

  it("stores privileged credential input without returning the submitted token", async () => {
    const store = new MemoryCredentialStore();
    const approvalQueue = {
      request: vi.fn(async () => "deny" as const),
      requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
      requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
      requestCredentialInput: vi.fn(async () => ({
        decision: "submit" as const,
        values: { token: "github_pat_secret" },
      })),
      resolve: vi.fn(),
      submitClientConfig: vi.fn(),
      submitSecretInput: vi.fn(),
      submitCredentialInput: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
      sessionGrantStore: new CredentialSessionGrantStore(),
    });

    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "requestCredentialInput",
      [
        {
          title: "Add GitHub",
          credential: {
            label: "GitHub",
            audience: [{ url: "https://api.github.com/", match: "origin" }],
            injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
            accountIdentity: { providerUserId: "github-pat" },
            metadata: { providerId: "github" },
          },
          fields: [{ name: "token", label: "Fine-grained PAT", type: "secret", required: true }],
          material: { type: "bearer-token", tokenField: "token" },
        },
      ]
    )) as StoredCredentialSummary;

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

  it("allows DO callers to request credential input approvals", async () => {
    const store = new MemoryCredentialStore();
    const approvalQueue = {
      request: vi.fn(async () => "deny" as const),
      requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
      requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
      requestCredentialInput: vi.fn(async () => ({
        decision: "submit" as const,
        values: { token: "agent_secret" },
      })),
      resolve: vi.fn(),
      submitClientConfig: vi.fn(),
      submitSecretInput: vi.fn(),
      submitCredentialInput: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
      sessionGrantStore: new CredentialSessionGrantStore(),
    });

    await expect(
      service.handler(
        { caller: verifiedTestCaller("do:workers/agent-worker:AiChatWorker:agent-1", "do") },
        "requestCredentialInput",
        [
          {
            title: "Add model key",
            credential: {
              label: "Model API",
              audience: [{ url: "https://api.example.test/", match: "origin" }],
              injection: {
                type: "header",
                name: "Authorization",
                valueTemplate: "Bearer {token}",
              },
              accountIdentity: { providerUserId: "agent-model" },
            },
            fields: [{ name: "token", label: "API key", type: "secret", required: true }],
            material: { type: "bearer-token", tokenField: "token" },
          },
        ]
      )
    ).resolves.toMatchObject({ label: "Model API" });
    expect(approvalQueue.requestCredentialInput).toHaveBeenCalledWith(
      expect.objectContaining({
        callerId: "do:workers/agent-worker:AiChatWorker:agent-1",
        callerKind: "do",
        repoPath: "/owner",
      })
    );
  });

  it("only accepts one required secret field for privileged credential input", async () => {
    const approvalQueue = {
      request: vi.fn(async () => "deny" as const),
      requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
      requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
      requestCredentialInput: vi.fn(async () => ({
        decision: "submit" as const,
        values: { token: "github_pat_secret" },
      })),
      resolve: vi.fn(),
      submitClientConfig: vi.fn(),
      submitSecretInput: vi.fn(),
      submitCredentialInput: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      approvalQueue: approvalQueue as never,
      sessionGrantStore: new CredentialSessionGrantStore(),
    });
    const baseRequest = {
      title: "Add GitHub",
      credential: {
        label: "GitHub",
        audience: [{ url: "https://api.github.com/", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
      },
      fields: [{ name: "token", label: "Fine-grained PAT", type: "secret", required: true }],
      material: { type: "bearer-token", tokenField: "token" },
    };
    const ctx = { caller: verifiedTestCaller("worker:test", "worker") };

    await expect(
      service.handler(ctx, "requestCredentialInput", [
        {
          ...baseRequest,
          fields: [
            ...baseRequest.fields,
            { name: "username", label: "Username", type: "text", required: true },
          ],
        },
      ])
    ).rejects.toThrow("Credential input expects exactly one secret field");

    await expect(
      service.handler(ctx, "requestCredentialInput", [
        {
          ...baseRequest,
          fields: [{ name: "token", label: "Token", type: "text", required: true }],
        },
      ])
    ).rejects.toThrow("Credential input tokenField must be a secret field");

    expect(approvalQueue.requestCredentialInput).not.toHaveBeenCalled();
  });

  it("prompts userland callers without owner or grant access before revoking credentials", async () => {
    const store = new MemoryCredentialStore();
    const approvalQueue = approvingQueue("once");
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
    });

    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:owner", "worker") },
      "storeCredential",
      [
        {
          label: "Example API",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
          material: { type: "bearer-token", token: "secret-token" },
        },
      ]
    )) as StoredCredentialSummary;

    await service.handler(
      { caller: verifiedTestCaller("worker:other", "worker") },
      "revokeCredential",
      [{ credentialId: stored.id }]
    );

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "capability",
        capability: "credential-revoke",
        severity: "severe",
        callerId: "worker:other",
        callerKind: "worker",
        repoPath: "/other",
        effectiveVersion: "hash-2",
        title: "Revoke Example API",
        resource: { type: "credential", label: "Credential", value: "Example API" },
      })
    );
    expect((await store.loadUrlBound(stored.id))?.revokedAt).toEqual(expect.any(Number));
  });

  it("does not revoke credentials when the out-of-band revocation approval is denied", async () => {
    const store = new MemoryCredentialStore();
    const approvalQueue = approvingQueue("once");
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
    });

    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:owner", "worker") },
      "storeCredential",
      [
        {
          label: "Example API",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
          material: { type: "bearer-token", token: "secret-token" },
        },
      ]
    )) as StoredCredentialSummary;
    approvalQueue.request.mockResolvedValue("deny");

    await expect(
      service.handler(
        { caller: verifiedTestCaller("worker:other", "worker") },
        "revokeCredential",
        [{ credentialId: stored.id }]
      )
    ).rejects.toThrow(/Credential revocation denied/);

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "capability",
        capability: "credential-revoke",
        callerId: "worker:other",
      })
    );

    expect((await store.loadUrlBound(stored.id))?.revokedAt).toBeUndefined();
  });

  it("defers resolveCredential approval for a deferrable DO caller instead of awaiting inline", async () => {
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
    });

    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:first", "worker") },
      "storeCredential",
      [
        {
          label: "Example API",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
          material: { type: "bearer-token", token: "secret-token" },
        },
      ]
    )) as StoredCredentialSummary;
    approvalQueue.request.mockClear();

    let capturedWork: ((signal: AbortSignal) => Promise<unknown>) | null = null;
    const ctx: ServiceContext = {
      caller: verifiedTestCaller("do:workers/agent-worker:AiChatWorker:first", "do"),
      requestId: "req-defer-1",
      deferral: {
        canDefer: true,
        run: (work) => {
          capturedWork = work;
          return { [DEFERRED_RESULT]: true, requestId: "req-defer-1" } as const;
        },
      },
    };

    const outcome = await service.handler(ctx, "resolveCredential", [
      { url: "https://api.example.test/v1" },
    ]);

    // Returns the deferral sentinel, NOT the summary — approval is not awaited inline.
    expect(isDeferredResult(outcome)).toBe(true);
    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(capturedWork).toBeTypeOf("function");

    // Running the deferred work performs the approval and yields the summary.
    const result = await capturedWork!(new AbortController().signal);
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ id: stored.id });
  });

  it("promotes deferrable one-shot credential approvals so resumed callers do not re-prompt", async () => {
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
    });

    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:first", "worker") },
      "storeCredential",
      [
        {
          label: "Example API",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
          material: { type: "bearer-token", token: "secret-token" },
        },
      ]
    )) as StoredCredentialSummary;
    approvalQueue.request.mockClear();

    let capturedWork: ((signal: AbortSignal) => Promise<unknown>) | null = null;
    const caller = verifiedTestCaller("do:workers/agent-worker:AiChatWorker:first", "do");
    const ctx: ServiceContext = {
      caller,
      requestId: "req-defer-once",
      deferral: {
        canDefer: true,
        run: (work) => {
          capturedWork = work;
          return { [DEFERRED_RESULT]: true, requestId: "req-defer-once" } as const;
        },
      },
    };

    const outcome = await service.handler(ctx, "resolveCredential", [
      { url: "https://api.example.test/v1" },
    ]);
    expect(isDeferredResult(outcome)).toBe(true);

    await expect(capturedWork!(new AbortController().signal)).resolves.toMatchObject({
      id: stored.id,
    });
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);

    await expect(
      service.handler({ caller }, "resolveCredential", [{ url: "https://api.example.test/v1" }])
    ).resolves.toMatchObject({ id: stored.id });
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
  });

  it("passes the deferral abort signal into interactive connect approvals", async () => {
    const store = new MemoryCredentialStore();
    let capturedWork: ((signal: AbortSignal) => Promise<unknown>) | null = null;
    let requestStarted!: () => void;
    const requestStartedPromise = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    let approvalSignal: AbortSignal | undefined;
    const approvalQueue = {
      request: vi.fn(
        (req: { signal?: AbortSignal }) =>
          new Promise<"deny">((resolve) => {
            approvalSignal = req.signal;
            requestStarted();
            req.signal?.addEventListener("abort", () => resolve("deny"), { once: true });
          })
      ),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
    });
    const controller = new AbortController();
    const ctx: ServiceContext = {
      caller: verifiedTestCaller("do:workers/agent-worker:AiChatWorker:first", "do"),
      requestId: "req-connect-1",
      deferral: {
        canDefer: true,
        run: (work) => {
          capturedWork = work;
          return { [DEFERRED_RESULT]: true, requestId: "req-connect-1" } as const;
        },
      },
    };

    const outcome = await service.handler(ctx, "connect", [
      {
        flow: {
          type: "oauth2-device-code",
          deviceAuthorizationUrl: "https://auth.example.test/device",
          tokenUrl: "https://auth.example.test/token",
          clientId: "client-1",
        },
        credential: {
          label: "Device API",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
        },
      },
    ]);

    expect(isDeferredResult(outcome)).toBe(true);
    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(capturedWork).toBeTypeOf("function");

    const workPromise = capturedWork!(controller.signal);
    await requestStartedPromise;
    expect(approvalSignal).toBe(controller.signal);

    controller.abort();
    await expect(workPromise).rejects.toThrow(/Credential approval denied/);
  });

  it("keeps session approvals process-local and scoped to the concrete caller", async () => {
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
    });

    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:first", "worker") },
      "storeCredential",
      [
        {
          label: "Example API",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
          material: { type: "bearer-token", token: "secret-token" },
        },
      ]
    )) as StoredCredentialSummary;

    expect((await store.loadUrlBound(stored.id))?.grants).toEqual([]);
    approvalQueue.request.mockClear();

    await expect(
      service.handler(
        { caller: verifiedTestCaller("do:workers/agent-worker:AiChatWorker:first", "do") },
        "resolveCredential",
        [{ url: "https://api.example.test/v1" }]
      )
    ).resolves.toMatchObject({ id: stored.id });
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenLastCalledWith(
      expect.objectContaining({
        callerId: "do:workers/agent-worker:AiChatWorker:first",
        callerKind: "do",
        repoPath: "/owner",
      })
    );

    await service.handler(
      { caller: verifiedTestCaller("worker:new-version", "worker") },
      "resolveCredential",
      [{ url: "https://api.example.test/v1" }]
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
    });

    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:owner", "worker") },
      "storeCredential",
      [
        {
          label: "Example API",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
          material: { type: "bearer-token", token: "secret-token" },
        },
      ]
    )) as StoredCredentialSummary;
    approvalQueue.request.mockClear();

    await service.handler(
      { caller: verifiedTestCaller("worker:consumer", "worker") },
      "resolveCredential",
      [{ url: "https://api.example.test/v1" }]
    );
    await service.handler(
      { caller: verifiedTestCaller("worker:consumer", "worker") },
      "resolveCredential",
      [{ url: "https://api.example.test/v1" }]
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
    });

    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:owner", "worker") },
      "storeCredential",
      [
        {
          label: "Example API",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
          material: { type: "bearer-token", token: "secret-token" },
        },
      ]
    )) as StoredCredentialSummary;
    approvalQueue.request.mockClear();

    await service.handler(
      { caller: verifiedTestCaller("worker:consumer", "worker") },
      "resolveCredential",
      [{ url: "https://api.example.test/v1" }]
    );
    await service.handler(
      { caller: verifiedTestCaller("worker:consumer", "worker") },
      "resolveCredential",
      [{ url: "https://api.example.test/v1" }]
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
      })
    );
  });

  it("ignores central embedded credential grants when a workspace grant store is active", async () => {
    const store = new MemoryCredentialStore();
    const seedService = createCredentialService({
      credentialStore: store as never,
    });
    const stored = (await seedService.handler(
      { caller: verifiedTestCaller("worker:owner", "worker") },
      "storeCredential",
      [
        {
          label: "Example API",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
          material: { type: "bearer-token", token: "secret-token" },
        },
      ]
    )) as StoredCredentialSummary;
    const persisted = await store.loadUrlBound(stored.id);
    await store.saveUrlBound({
      ...(persisted as Credential & { id: string }),
      grants: [
        {
          bindingId: "fetch",
          use: "fetch",
          resource: "https://api.example.test/",
          action: "use",
          scope: "version",
          repoPath: "/consumer",
          effectiveVersion: "hash-1",
          grantedAt: 1,
          grantedBy: "version",
        },
      ],
    });

    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
      sessionGrantStore: new CredentialSessionGrantStore(),
      credentialUseGrantStore: new MemoryCredentialUseGrantStore(),
    });

    await expect(
      service.handler(
        { caller: verifiedTestCaller("worker:consumer", "worker") },
        "resolveCredential",
        [{ url: "https://api.example.test/v1" }]
      )
    ).resolves.toMatchObject({ id: stored.id });
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
  });

  it("resolves queued credential use approvals covered by a trusted version grant", async () => {
    const store = new MemoryCredentialStore();
    const seedService = createCredentialService({
      credentialStore: store as never,
    });
    const stored = (await seedService.handler(
      { caller: verifiedTestCaller("worker:owner", "worker") },
      "storeCredential",
      [
        {
          label: "Example API",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
          material: { type: "bearer-token", token: "secret-token" },
        },
      ]
    )) as StoredCredentialSummary;
    const emit = vi.fn();
    const approvalQueue = createApprovalQueue({ eventService: { emit } as never });
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue,
      sessionGrantStore: new CredentialSessionGrantStore(),
    });
    const callerA = createVerifiedCaller("worker:consumer-a", "worker", {
      callerId: "worker:consumer-a",
      callerKind: "worker",
      repoPath: "/consumer",
      effectiveVersion: "hash-1",
    });
    const callerB = createVerifiedCaller("worker:consumer-b", "worker", {
      callerId: "worker:consumer-b",
      callerKind: "worker",
      repoPath: "/consumer",
      effectiveVersion: "hash-1",
    });

    const first = service.handler({ caller: callerA }, "resolveCredential", [
      { url: "https://api.example.test/v1" },
    ]);
    await vi.waitFor(() => expect(approvalQueue.listPending()).toHaveLength(1));
    const second = service.handler({ caller: callerB }, "resolveCredential", [
      { url: "https://api.example.test/v1" },
    ]);
    await vi.waitFor(() => expect(approvalQueue.listPending()).toHaveLength(2));

    approvalQueue.resolve(approvalQueue.listPending()[0]!.approvalId, "version");

    await expect(first).resolves.toMatchObject({ id: stored.id });
    await expect(second).resolves.toMatchObject({ id: stored.id });
    expect(approvalQueue.listPending()).toEqual([]);
    expect((await store.loadUrlBound(stored.id))?.grants).toContainEqual(
      expect.objectContaining({
        bindingId: "fetch",
        use: "fetch",
        resource: "https://api.example.test/",
        action: "use",
        scope: "version",
        repoPath: "/consumer",
        effectiveVersion: "hash-1",
      })
    );
  });

  it("fails loud for an explicit public redirect when no relay is configured (the default falls back to loopback)", async () => {
    // The relay path is deliberately fail-loud when unconfigured — it must not
    // silently emit a server URL no third party can reach. The DEFAULT, by
    // contrast, falls back to loopback when no relay is set (see
    // resolveDefaultRedirectStrategy) so co-located `pnpm dev` OAuth still works.
    // This is the negative the harness previously masked by stubbing the relay env.
    delete process.env["NATSTACK_RELAY_OAUTH_BASE_URL"];
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue("version") as never,
    });
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };

    await expect(
      service.handler(ctx, "connect", [
        {
          redirect: { type: "public" },
          flow: {
            type: "oauth2-auth-code-pkce",
            authorizeUrl: "https://auth.example.test/oauth/authorize",
            tokenUrl: "https://auth.example.test/oauth/token",
            clientId: "client-1",
            scopes: ["read"],
          },
          credential: {
            label: "Relay OAuth",
            audience: [{ url: "https://api.example.test/v1", match: "path-prefix" }],
            injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
            accountIdentity: { email: "dev@example.test" },
          },
        },
      ])
    ).rejects.toThrow(/relay is not configured|redirect_unavailable/i);
    // The authorize URL is never emitted — connect fails at redirect resolution.
    expect(emit).not.toHaveBeenCalledWith("external-open:open", expect.anything());
  });

  it("creates URL-bound credentials through generic OAuth PKCE and discards refresh tokens", async () => {
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue("version") as never,
    });
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };

    const started = await startOAuthConnection(service, emit, ctx, {
      flow: {
        type: "oauth2-auth-code-pkce",
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

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect(init?.method).toBe("POST");
        const body = init?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("authorization_code");
        expect(body.get("client_id")).toBe("client-1");
        expect(body.get("code_verifier")).toBeTruthy();
        return new Response(
          JSON.stringify({
            access_token: "oauth-access-token",
            refresh_token: "must-not-persist",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      })
    );

    await deliverOAuthCallback(
      started.redirectUri,
      new URLSearchParams({
        code: "code-1",
        state: started.state,
      })
    );
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
        repoPath: "/repo",
        effectiveVersion: "hash-1",
        grantedBy: "version",
      }),
    ]);
    expect(JSON.stringify(persisted)).not.toContain("must-not-persist");
  });

  it("persists OAuth PKCE refresh tokens when the flow opts into durable refresh", async () => {
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue("version") as never,
    });
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };

    const started = await startOAuthConnection(service, emit, ctx, {
      flow: {
        type: "oauth2-auth-code-pkce",
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
        scopes: ["read", "write"],
        persistRefreshToken: true,
        extraAuthorizeParams: {
          access_type: "offline",
          prompt: "consent",
        },
      },
      credential: {
        label: "Durable OAuth",
        audience: [{ url: "https://api.example.test/v1", match: "path-prefix" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        accountIdentity: { email: "dev@example.test" },
      },
    });

    expect(started.authorizeUrl.searchParams.get("access_type")).toBe("offline");
    expect(started.authorizeUrl.searchParams.get("prompt")).toBe("consent");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as URLSearchParams;
        expect(body.get("grant_type")).toBe("authorization_code");
        return new Response(
          JSON.stringify({
            access_token: "oauth-access-token",
            refresh_token: "durable-refresh-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      })
    );

    await deliverOAuthCallback(
      started.redirectUri,
      new URLSearchParams({
        code: "code-1",
        state: started.state,
      })
    );
    const completed = await started.pending;

    expect(completed.metadata?.["oauthRefreshTokenStored"]).toBe("true");
    expect(JSON.stringify(completed)).not.toContain("durable-refresh-token");

    const persisted = await store.loadUrlBound(completed.id);
    expect(persisted?.accessToken).toBe("oauth-access-token");
    expect(persisted?.refreshToken).toBe("durable-refresh-token");
  });

  it("credentials.connect owns browser handoff, callback validation, token exchange, and initial grant", async () => {
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const approvalQueue = {
      request: vi.fn(async () => "session" as const),
      requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
      requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
      requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
      resolve: vi.fn(),
      submitClientConfig: vi.fn(),
      submitSecretInput: vi.fn(),
      submitCredentialInput: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvalQueue as never,
    });
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as URLSearchParams;
        expect(body.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);
        return new Response(
          JSON.stringify({
            access_token: "oauth-access-token",
            refresh_token: "must-not-persist",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        );
      })
    );

    const pending = service.handler(ctx, "connect", [
      {
        flow: {
          type: "oauth2-auth-code-pkce",
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
        redirect: { type: "loopback" },
      },
    ]) as Promise<StoredCredentialSummary>;

    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(
        "external-open:open",
        expect.objectContaining({ callerId: "panel-test" })
      )
    );
    const authorizeUrl = new URL(emit.mock.calls[0]![1].url);
    const redirectUri = authorizeUrl.searchParams.get("redirect_uri");
    const state = authorizeUrl.searchParams.get("state");
    expect(redirectUri).toBeTruthy();
    expect(state).toBeTruthy();
    await new Promise<void>((resolve, reject) => {
      http
        .get(`${redirectUri}?code=code-1&state=${state}`, (res) => {
          res.resume();
          res.on("end", resolve);
        })
        .on("error", reject);
    });

    const completed = await pending;
    expect(completed.label).toBe("Example OAuth");
    expect((await store.loadUrlBound(completed.id))?.accessToken).toBe("oauth-access-token");
    expect(JSON.stringify(await store.loadUrlBound(completed.id))).not.toContain(
      "must-not-persist"
    );
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        credentialLabel: "Example OAuth",
        oauthAuthorizeOrigin: "https://auth.example.test",
        oauthTokenOrigin: "https://auth.example.test",
      })
    );

    const agent = { kind: "agent" as const, id: "agent-openai", displayName: "OpenAI Codex" };
    const participant = { ...agent, participantId: "agent-openai" };
    const channelId = brandId<ChannelId>("channel-credential-smoke");
    const turnId = brandId<TurnId>("turn-credential-reconnect");
    const messageId = brandId<MessageId>("msg-credential-reconnect");
    const blockId = brandId<BlockId>("msg-credential-reconnect:block:0");
    const credKey = "cred:channel-credential-smoke:openai-codex";
    const credentialEnvelope: ChannelEnvelope<Record<string, unknown>> = {
      envelopeId: brandId<EnvelopeId>("env-credential-request"),
      channelId,
      seq: 1,
      from: participant,
      payloadKind: CREDENTIAL_CONNECT_PAYLOAD_KIND,
      payload: {
        credKey,
        providerId: "openai-codex",
        connectSpec: { providerId: "openai-codex", browser: "external" },
        modelBaseUrl: "https://chatgpt.com/backend-api/codex",
        reason: "Provided authentication token is expired. Please try signing in again.",
        failureCode: "auth_or_credentials",
      },
      publishedAt: "2026-06-18T15:00:00.000Z",
    };
    const eventEnvelope = (payload: AgenticEvent, seq: number): ChannelEnvelope<AgenticEvent> => ({
      envelopeId: brandId<EnvelopeId>(`env-credential-smoke-${seq}`),
      channelId,
      seq,
      from: participant,
      payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
      payload,
      publishedAt: payload.createdAt,
    });
    const opened: AgenticEvent<"turn.opened"> = {
      kind: "turn.opened",
      actor: agent,
      turnId,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION },
      createdAt: "2026-06-18T15:00:01.000Z",
    };
    const waiting: AgenticEvent<"turn.waiting"> = {
      kind: "turn.waiting",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        reason: "model_credential_reconnect_required",
        summary: "Waiting for model credential reconnect",
      },
      createdAt: "2026-06-18T15:00:02.000Z",
    };
    const resolved: AgenticEvent<"system.event"> = {
      kind: "system.event",
      actor: agent,
      turnId,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        kind: "credential.wait_resolved",
        details: {
          kind: "credential.wait_resolved",
          credKey,
          providerId: "openai-codex",
          resolved: true,
        },
      },
      createdAt: "2026-06-18T15:00:03.000Z",
    };
    const resumed: AgenticEvent<"message.started"> = {
      kind: "message.started",
      actor: agent,
      turnId,
      causality: { messageId },
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, role: "assistant" },
      createdAt: "2026-06-18T15:00:04.000Z",
    };
    const delta: AgenticEvent<"message.delta"> = {
      kind: "message.delta",
      actor: agent,
      turnId,
      causality: { messageId },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        blockId,
        type: "text",
        text: "Resumed after reconnect.",
      },
      createdAt: "2026-06-18T15:00:05.000Z",
    };

    const credentialState = reduceChannelView(createInitialChannelViewState(), credentialEnvelope);
    expect(chatMessagesFromChannelView(credentialState)).toEqual([
      expect.objectContaining({ contentType: "credential-connect" }),
    ]);

    const activeState = [opened, waiting, resolved, resumed]
      .map((event, index) => eventEnvelope(event, index + 2))
      .reduce(reduceChannelView, credentialState);
    const activeMessages = chatMessagesFromChannelView(activeState);
    expect(activeMessages.some((message) => message.contentType === "credential-connect")).toBe(
      false
    );
    expect(activeMessages).toContainEqual(
      expect.objectContaining({
        id: "turn:turn-credential-reconnect",
        contentType: "typing",
        complete: false,
      })
    );

    const outputState = reduceChannelView(activeState, eventEnvelope(delta, 6));
    expect(chatMessagesFromChannelView(outputState)).toContainEqual(
      expect.objectContaining({
        id: "msg-credential-reconnect",
        content: "Resumed after reconnect.",
      })
    );
  });

  it("credentials.connect can open OAuth externally for a worker-requested panel handoff", async () => {
    const emit = vi.fn();
    const eventService = targetedOpenEventService(emit);
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: eventService as never,
      connectionLookup: authorizingShellLookup("owner-conn"),
      approvalQueue: approvingQueue() as never,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "token",
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    const pending = service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "connect",
      [
        {
          spec: {
            flow: {
              type: "oauth2-auth-code-pkce",
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
            redirect: { type: "loopback" },
          },
          handoffTarget: {
            callerId: "panel-test",
            callerKind: "panel",
          },
        },
      ]
    ) as Promise<StoredCredentialSummary>;

    await vi.waitFor(() =>
      expect(eventService.emitToConnection).toHaveBeenCalledWith(
        "shell:owner",
        "owner-conn",
        "external-open:open",
        expect.objectContaining({
          callerId: "worker:test",
          callerKind: "worker",
        })
      )
    );
    const authorizeUrl = new URL(emit.mock.calls[0]![1].url);
    await deliverOAuthCallback(
      authorizeUrl.searchParams.get("redirect_uri")!,
      new URLSearchParams({
        code: "code-1",
        state: authorizeUrl.searchParams.get("state")!,
      })
    );
    await pending;
  });

  it("credentials.connect can open OAuth externally for a worker-requested app handoff", async () => {
    const emit = vi.fn();
    const eventService = targetedOpenEventService(emit);
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: eventService as never,
      approvalQueue: approvingQueue() as never,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "token",
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    const pending = service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "connect",
      [
        {
          spec: {
            flow: {
              type: "oauth2-auth-code-pkce",
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
            redirect: { type: "loopback" },
          },
          handoffTarget: {
            callerId: "@workspace-apps/shell",
            callerKind: "app",
          },
        },
      ]
    ) as Promise<StoredCredentialSummary>;

    await vi.waitFor(() =>
      expect(eventService.emitToCaller).toHaveBeenCalledWith(
        "@workspace-apps/shell",
        "external-open:open",
        expect.objectContaining({
          callerId: "worker:test",
          callerKind: "worker",
        })
      )
    );
    const authorizeUrl = new URL(emit.mock.calls[0]![1].url);
    await deliverOAuthCallback(
      authorizeUrl.searchParams.get("redirect_uri")!,
      new URLSearchParams({
        code: "code-1",
        state: authorizeUrl.searchParams.get("state")!,
      })
    );
    await pending;
  });

  it("falls back to caller-wide browser handoff when a remembered owner connection is stale", async () => {
    const emit = vi.fn();
    const eventService = {
      emit: vi.fn(),
      emitToConnection: vi.fn(() => false),
      emitToCaller: vi.fn((callerId: string, event: string, payload: unknown) => {
        emit(event, payload);
        return callerId.length > 0;
      }),
    };
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: eventService as never,
      connectionLookup: authorizingShellLookup("stale-owner-conn"),
      approvalQueue: approvingQueue() as never,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "token",
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    const pending = service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "connect",
      [
        {
          spec: {
            flow: {
              type: "oauth2-auth-code-pkce",
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
            redirect: { type: "loopback" },
          },
          handoffTarget: {
            callerId: "panel-test",
            callerKind: "panel",
          },
        },
      ]
    ) as Promise<StoredCredentialSummary>;

    await vi.waitFor(() => expect(eventService.emitToCaller).toHaveBeenCalled());
    expect(eventService.emitToConnection).toHaveBeenCalledWith(
      "shell:owner",
      "stale-owner-conn",
      "external-open:open",
      expect.objectContaining({ callerId: "worker:test" })
    );
    expect(eventService.emitToCaller).toHaveBeenCalledWith(
      "shell:owner",
      "external-open:open",
      expect.objectContaining({ callerId: "worker:test" })
    );
    const authorizeUrl = new URL(emit.mock.calls[0]![1].url);
    await deliverOAuthCallback(
      authorizeUrl.searchParams.get("redirect_uri")!,
      new URLSearchParams({
        code: "code-1",
        state: authorizeUrl.searchParams.get("state")!,
      })
    );
    await pending;
  });

  it("credentials.connect can open OAuth in an internal browser panel for a worker-requested panel handoff", async () => {
    const emit = vi.fn();
    const eventService = targetedOpenEventService(emit);
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: eventService as never,
      connectionLookup: authorizingShellLookup(),
      approvalQueue: approvingQueue() as never,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "token",
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    const pending = service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "connect",
      [
        {
          spec: {
            flow: {
              type: "oauth2-auth-code-pkce",
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
            redirect: { type: "loopback" },
          },
          handoffTarget: {
            callerId: "panel-test",
            callerKind: "panel",
          },
        },
      ]
    ) as Promise<StoredCredentialSummary>;

    await vi.waitFor(() =>
      expect(eventService.emitToConnection).toHaveBeenCalledWith(
        "shell:owner",
        "owner-conn",
        "browser-panel:open",
        expect.objectContaining({
          parentPanelId: "panel-test",
          callerId: "worker:test",
          callerKind: "worker",
        })
      )
    );
    const authorizeUrl = new URL(emit.mock.calls[0]![1].url);
    await deliverOAuthCallback(
      authorizeUrl.searchParams.get("redirect_uri")!,
      new URLSearchParams({
        code: "code-1",
        state: authorizeUrl.searchParams.get("state")!,
      })
    );
    await pending;
  });

  it("fails immediately when the OAuth browser handoff target is not connected", async () => {
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: {
        emit: vi.fn(),
        emitToCaller: vi.fn(() => false),
        emitToConnection: vi.fn(() => false),
      } as never,
      approvalQueue: approvingQueue() as never,
    });

    const error = await service
      .handler({ caller: verifiedTestCaller("worker:test", "worker") }, "connect", [
        {
          spec: {
            flow: {
              type: "oauth2-auth-code-pkce",
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
            callerId: "panel-missing",
            callerKind: "panel",
          },
        },
      ])
      .then(
        () => {
          throw new Error("expected OAuth handoff to fail");
        },
        (rejection: Error & { code?: string }) => rejection
      );
    expect(error).toMatchObject({ code: "browser_unavailable" });
    expect(error.message).toContain("target=panel:panel-missing");
    expect(error.message).toContain("ownerLookup=not-configured");
    expect(error.message).toContain("attempt=emit-to-caller");
    expect(error.message).toContain("delivered=false");
  });

  it("fails immediately when a panel handoff has no connected shell owner", async () => {
    const emitToCaller = vi.fn(() => true);
    const emitToConnection = vi.fn(() => true);
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: {
        emit: vi.fn(),
        emitToCaller,
        emitToConnection,
      } as never,
      connectionLookup: { getAuthorizingShell: vi.fn(() => null) },
      approvalQueue: approvingQueue() as never,
    });

    const error = await service
      .handler({ caller: verifiedTestCaller("worker:test", "worker") }, "connect", [
        {
          spec: {
            flow: {
              type: "oauth2-auth-code-pkce",
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
            callerId: "panel-missing-owner",
            callerKind: "panel",
          },
        },
      ])
      .then(
        () => {
          throw new Error("expected OAuth handoff to fail");
        },
        (rejection: Error & { code?: string }) => rejection
      );
    expect(error).toMatchObject({ code: "browser_unavailable" });
    expect(error.message).toContain("target=panel:panel-missing-owner");
    expect(error.message).toContain("ownerLookup=missing");
    expect(error.message).not.toContain("attempt=");
    expect(emitToCaller).not.toHaveBeenCalled();
    expect(emitToConnection).not.toHaveBeenCalled();
  });

  it("supports authenticated client-forwarded mobile callbacks by state", async () => {
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "token",
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    const pending = service.handler({ caller: verifiedTestCaller("shell", "shell") }, "connect", [
      {
        flow: {
          type: "oauth2-auth-code-pkce",
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
      },
    ]) as Promise<StoredCredentialSummary>;

    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(
        "external-open:open",
        expect.objectContaining({ callerId: "shell" })
      )
    );
    const authorizeUrl = new URL(emit.mock.calls[0]![1].url);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://auth.snugenv.com/oauth/callback/example"
    );
    const state = authorizeUrl.searchParams.get("state")!;

    await service.handler(
      { caller: verifiedTestCaller("shell", "shell") },
      "forwardOAuthCallback",
      [
        {
          url: `https://auth.snugenv.com/oauth/callback/example?code=code-1&state=${state}`,
        },
      ]
    );

    await expect(pending).resolves.toMatchObject({ label: "Example OAuth" });
  });

  it("supports authenticated client-loopback callbacks from the browser handoff shell", async () => {
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const eventService = targetedOpenEventService(emit);
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: eventService as never,
      connectionLookup: authorizingShellLookup(),
      approvalQueue: approvingQueue() as never,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as URLSearchParams;
        expect(body.get("redirect_uri")).toBe("http://localhost:1455/auth/callback");
        return new Response(
          JSON.stringify({
            access_token: "token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    const pending = service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "connect",
      [
        {
          spec: {
            flow: {
              type: "oauth2-auth-code-pkce",
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
              type: "client-loopback",
              host: "localhost",
              port: 1455,
              callbackPath: "/auth/callback",
            },
            browser: "external",
          },
          handoffTarget: {
            callerId: "panel-test",
            callerKind: "panel",
          },
        },
      ]
    ) as Promise<StoredCredentialSummary>;

    await vi.waitFor(() =>
      expect(eventService.emitToConnection).toHaveBeenCalledWith(
        "shell:owner",
        "owner-conn",
        "external-open:open",
        expect.objectContaining({
          callerId: "worker:test",
          oauthLoopback: expect.objectContaining({
            redirectUri: "http://localhost:1455/auth/callback",
            host: "localhost",
            port: 1455,
            callbackPath: "/auth/callback",
          }),
        })
      )
    );
    const payload = emit.mock.calls[0]![1] as {
      url: string;
      oauthLoopback: { transactionId: string; state: string };
    };
    const authorizeUrl = new URL(payload.url);
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "http://localhost:1455/auth/callback"
    );

    await expect(
      service.handler(
        { caller: verifiedTestCaller("shell:other", "shell") },
        "forwardOAuthCallback",
        [
          {
            transactionId: payload.oauthLoopback.transactionId,
            url: `http://localhost:1455/auth/callback?code=code-1&state=${payload.oauthLoopback.state}`,
          },
        ]
      )
    ).rejects.toMatchObject({ code: "client_not_authorized" });

    await service.handler(
      { caller: verifiedTestCaller("shell:owner", "shell") },
      "forwardOAuthCallback",
      [
        {
          transactionId: payload.oauthLoopback.transactionId,
          url: `http://localhost:1455/auth/callback?code=code-1&state=${payload.oauthLoopback.state}`,
        },
      ]
    );

    await expect(pending).resolves.toMatchObject({ label: "Example OAuth" });
    expect((await store.loadUrlBound((await pending).id))?.accessToken).toBe("token");
  });

  it("rejects client-loopback for OAuth1", async () => {
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: targetedOpenEventService(vi.fn()) as never,
      clientConfigStore: {
        load: vi.fn(async () => ({
          configId: "twitter",
          title: "Twitter",
          authorizeUrl: "https://auth.example.test/oauth/authorize",
          tokenUrl: "https://auth.example.test/oauth/token",
          fields: {
            consumerKey: { type: "text", value: "key", updatedAt: Date.now() },
            consumerSecret: { type: "secret", value: "secret", updatedAt: Date.now() },
          },
          flowTypes: ["oauth1a"],
          status: "active",
          updatedAt: Date.now(),
        })),
        summarize: vi.fn(),
      } as never,
      approvalQueue: approvingQueue() as never,
    });

    await expect(
      service.handler({ caller: verifiedTestCaller("shell", "shell") }, "connect", [
        {
          flow: {
            type: "oauth1a",
            requestTokenUrl: "https://auth.example.test/oauth/request_token",
            authorizeUrl: "https://auth.example.test/oauth/authorize",
            accessTokenUrl: "https://auth.example.test/oauth/access_token",
            clientConfigId: "twitter",
          },
          credential: {
            label: "Example OAuth1",
            audience: [{ url: "https://api.example.test/", match: "origin" }],
            injection: { type: "oauth1-signature" },
          },
          redirect: {
            type: "client-loopback",
            host: "localhost",
            port: 1455,
            callbackPath: "/auth/callback",
          },
        },
      ])
    ).rejects.toMatchObject({ code: "unsupported_flow" });
  });

  it("rejects forwarded OAuth callbacks that do not match the bound redirect URI", async () => {
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });

    const pending = service.handler({ caller: verifiedTestCaller("shell", "shell") }, "connect", [
      {
        flow: {
          type: "oauth2-auth-code-pkce",
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
      },
    ]) as Promise<StoredCredentialSummary>;

    await vi.waitFor(() => expect(emit).toHaveBeenCalled());
    const state = new URL(emit.mock.calls[0]![1].url).searchParams.get("state")!;
    await service.handler(
      { caller: verifiedTestCaller("shell", "shell") },
      "forwardOAuthCallback",
      [
        {
          url: `https://evil.example.test/oauth/callback/example?code=code-1&state=${state}`,
        },
      ]
    );

    await expect(pending).rejects.toMatchObject({ code: "redirect_mismatch" });
  });

  it("rejects public OAuth specs that include private browser handoff routing", async () => {
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: targetedOpenEventService(vi.fn()) as never,
      approvalQueue: approvingQueue() as never,
    });

    await expect(
      service.handler({ caller: verifiedTestCaller("panel-test", "panel") }, "connect", [
        {
          flow: {
            type: "oauth2-auth-code-pkce",
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
            targetCallerId: "panel-other",
            targetCallerKind: "panel",
          },
        },
      ])
    ).rejects.toThrow();
  });

  it("rejects panel callers that try to use the internal handoff envelope", async () => {
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: targetedOpenEventService(vi.fn()) as never,
      approvalQueue: approvingQueue() as never,
    });

    await expect(
      service.handler({ caller: verifiedTestCaller("panel-test", "panel") }, "connect", [
        {
          spec: {
            flow: {
              type: "oauth2-auth-code-pkce",
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
            callerId: "panel-other",
            callerKind: "panel",
          },
        },
      ])
    ).rejects.toMatchObject({ code: "client_not_authorized" });
  });

  it("surfaces sanitized OAuth token endpoint error details", async () => {
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };
    const started = await startOAuthConnection(service, emit, ctx, {
      flow: {
        type: "oauth2-auth-code-pkce",
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

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "invalid_client",
              error_description: "Unauthorized",
              refresh_token: "must-not-leak",
            }),
            { status: 400, headers: { "content-type": "application/json" } }
          )
      )
    );

    const pendingError: Promise<Error> = started.pending.then(
      () => {
        throw new Error("expected OAuth connection to fail");
      },
      (error: Error) => error
    );
    await deliverOAuthCallback(
      started.redirectUri,
      new URLSearchParams({
        code: "code-1",
        state: started.state,
      })
    );
    expect((await pendingError).message).toBe(
      "OAuth token exchange failed: 400 invalid_client: Unauthorized"
    );
  });

  it("maps provider-denied OAuth callbacks to approval_denied", async () => {
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };
    const started = await startOAuthConnection(service, emit, ctx, {
      flow: {
        type: "oauth2-auth-code-pkce",
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
      () => {
        throw new Error("expected OAuth connection to fail");
      },
      (error: Error) => error
    );
    await deliverOAuthCallback(
      started.redirectUri,
      new URLSearchParams({
        error: "access_denied",
        state: started.state,
      })
    );

    await expect(pendingError).resolves.toMatchObject({ code: "approval_denied" });
  });

  it("stores URL-bound client config from approval UI without returning secret values", async () => {
    const clientConfigStore = new MemoryClientConfigStore();
    const approvalQueue = {
      request: vi.fn(),
      requestClientConfig: vi.fn(async () => ({
        decision: "submit" as const,
        values: {
          clientId: "client-1",
          clientSecret: "secret-1",
        },
      })),
      requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
      requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
      resolve: vi.fn(),
      submitClientConfig: vi.fn(),
      submitSecretInput: vi.fn(),
      submitCredentialInput: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      clientConfigStore: clientConfigStore as never,
      approvalQueue: approvalQueue as never,
    });
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };

    const status = await service.handler(ctx, "configureClient", [
      {
        configId: "google-workspace",
        title: "Configure Google Workspace OAuth",
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        fields: [
          { name: "clientId", label: "Client ID", type: "text", required: true },
          { name: "clientSecret", label: "Client secret", type: "secret", required: true },
        ],
      },
    ]);

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
    expect((await clientConfigStore.load("google-workspace"))?.fields["clientSecret"]?.value).toBe(
      "secret-1"
    );
  });

  it("authorizes client config status and prompts before deletion", async () => {
    const clientConfigStore = new MemoryClientConfigStore();
    await clientConfigStore.save({
      configId: "google-workspace",
      currentVersion: "v1",
      owner: {
        callerId: "panel-owner",
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
      clientConfigStore: clientConfigStore as never,
      approvalQueue: approvalQueue as never,
    });

    await expect(
      service.handler(
        { caller: verifiedTestCaller("panel-other", "panel") },
        "getClientConfigStatus",
        [{ configId: "google-workspace" }]
      )
    ).resolves.toMatchObject({
      configId: "google-workspace",
      configured: true,
      fields: {
        clientId: { configured: true },
        clientSecret: { configured: true },
      },
    });

    await service.handler(
      { caller: verifiedTestCaller("panel-other", "panel") },
      "deleteClientConfig",
      [{ configId: "google-workspace" }]
    );

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "capability",
        capability: "client-config-delete",
        callerId: "panel-other",
        title: "Disable google-workspace",
        operation: expect.objectContaining({
          kind: "service-setup",
          object: expect.objectContaining({ value: "google-workspace" }),
        }),
      })
    );
    expect(await clientConfigStore.load("google-workspace")).toMatchObject({ status: "deleted" });
  });

  it("rejects client config URLs with fragments or token query parameters", async () => {
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      clientConfigStore: new MemoryClientConfigStore() as never,
      approvalQueue: {
        request: vi.fn(),
        requestClientConfig: vi.fn(),
        requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
        requestCredentialInput: vi.fn(),
        resolve: vi.fn(),
        submitClientConfig: vi.fn(),
        submitSecretInput: vi.fn(),
        submitCredentialInput: vi.fn(),
        listPending: vi.fn(() => []),
      } as never,
    });
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };
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

    await expect(
      service.handler(ctx, "configureClient", [
        {
          ...baseRequest,
          authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth#frag",
        },
      ])
    ).rejects.toThrow("authorizeUrl must not include a fragment");
    await expect(
      service.handler(ctx, "configureClient", [
        {
          ...baseRequest,
          tokenUrl: "https://oauth2.googleapis.com/token?client_secret=inline",
        },
      ])
    ).rejects.toThrow("tokenUrl must not include query parameters");
    await expect(
      service.handler(ctx, "configureClient", [
        {
          ...baseRequest,
          tokenUrl: "https://oauth2.googleapis.com/token#frag",
        },
      ])
    ).rejects.toThrow("tokenUrl must not include a fragment");
  });

  it("builds URL-bound client config PKCE without exposing client secrets in userland request", async () => {
    const clientConfigStore = new MemoryClientConfigStore();
    await clientConfigStore.save({
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
      clientConfigStore: clientConfigStore as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };

    const started = await startOAuthConnection(service, emit, ctx, {
      flow: {
        type: "oauth2-auth-code-pkce",
        clientConfigId: "google-workspace",
        tokenAuth: "client_secret_post",
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

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as URLSearchParams;
        expect(body.get("client_id")).toBe("client-1");
        expect(body.get("client_secret")).toBe("secret-1");
        return new Response(
          JSON.stringify({
            access_token: "token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    await deliverOAuthCallback(
      started.redirectUri,
      new URLSearchParams({
        code: "code-1",
        state: started.state,
      })
    );
    await started.pending;
  });

  it("includes stored client secrets by default for client-config PKCE when configured", async () => {
    const clientConfigStore = new MemoryClientConfigStore();
    await clientConfigStore.save({
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
      clientConfigStore: clientConfigStore as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });

    const started = await startOAuthConnection(
      service,
      emit,
      { caller: verifiedTestCaller("panel-test", "panel") },
      {
        flow: {
          type: "oauth2-auth-code-pkce",
          clientConfigId: "google-workspace",
        },
        credential: {
          label: "Google Workspace",
          audience: [{ url: "https://www.googleapis.com/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        },
      }
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as URLSearchParams;
        expect(body.get("client_id")).toBe("client-1");
        expect(body.get("client_secret")).toBe("secret-1");
        return new Response(
          JSON.stringify({
            access_token: "token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    await deliverOAuthCallback(
      started.redirectUri,
      new URLSearchParams({
        code: "code-1",
        state: started.state,
      })
    );
    await started.pending;
  });

  it("uses public-client token exchange by default for client-config PKCE", async () => {
    const clientConfigStore = new MemoryClientConfigStore();
    await clientConfigStore.save({
      configId: "public-app",
      authorizeUrl: "https://auth.example.test/oauth/authorize",
      tokenUrl: "https://auth.example.test/oauth/token",
      fields: {
        clientId: { value: "client-1", type: "text", updatedAt: 1 },
      },
      createdAt: 1,
      updatedAt: 1,
    });
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      clientConfigStore: clientConfigStore as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });

    const started = await startOAuthConnection(
      service,
      emit,
      { caller: verifiedTestCaller("panel-test", "panel") },
      {
        flow: {
          type: "oauth2-auth-code-pkce",
          clientConfigId: "public-app",
        },
        credential: {
          label: "Public App",
          audience: [{ url: "https://api.example.test/", match: "origin" }],
          injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        },
      }
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as URLSearchParams;
        expect(body.get("client_id")).toBe("client-1");
        expect(body.get("client_secret")).toBeNull();
        expect(body.get("client_assertion")).toBeNull();
        return new Response(
          JSON.stringify({
            access_token: "token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    await deliverOAuthCallback(
      started.redirectUri,
      new URLSearchParams({
        code: "code-1",
        state: started.state,
      })
    );
    await started.pending;
  });

  it("rejects client config updates that try to change URL bindings", async () => {
    const clientConfigStore = new MemoryClientConfigStore();
    await clientConfigStore.save({
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
      requestClientConfig: vi.fn(async () => ({
        decision: "submit" as const,
        values: {
          clientId: "client-2",
          clientSecret: "secret-2",
        },
      })),
      requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
      requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
      resolve: vi.fn(),
      submitClientConfig: vi.fn(),
      submitSecretInput: vi.fn(),
      submitCredentialInput: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      clientConfigStore: clientConfigStore as never,
      approvalQueue: approvalQueue as never,
    });

    await expect(
      service.handler(
        { caller: verifiedTestCaller("panel-test", "panel" as const) },
        "configureClient",
        [
          {
            configId: "google-workspace",
            title: "Configure Google Workspace OAuth",
            authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
            tokenUrl: "https://evil.example.test/token",
            fields: [
              { name: "clientId", label: "Client ID", type: "text", required: true },
              { name: "clientSecret", label: "Client secret", type: "secret", required: true },
            ],
          },
        ]
      )
    ).rejects.toThrow("tokenUrl is immutable");
  });

  it("surfaces OAuth origins and domain mismatch in credential approval requests", async () => {
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const approvalQueue = {
      request: vi.fn(async () => "session" as const),
      requestClientConfig: vi.fn(async () => ({ decision: "deny" as const })),
      requestSecretInput: vi.fn(async () => ({ decision: "deny" as const })),
      requestCredentialInput: vi.fn(async () => ({ decision: "deny" as const })),
      resolve: vi.fn(),
      submitClientConfig: vi.fn(),
      submitSecretInput: vi.fn(),
      submitCredentialInput: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvalQueue as never,
    });
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };

    const started = await startOAuthConnection(service, emit, ctx, {
      flow: {
        type: "oauth2-auth-code-pkce",
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

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "token",
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    await deliverOAuthCallback(
      started.redirectUri,
      new URLSearchParams({
        code: "code-1",
        state: started.state,
      })
    );
    await started.pending;

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        oauthAuthorizeOrigin: "https://accounts.example-login.test",
        oauthTokenOrigin: "https://accounts.example-login.test",
        oauthAudienceDomainMismatch: true,
      })
    );
  });

  it("rejects OAuth extra authorize params that override host-controlled PKCE fields", async () => {
    const service = createCredentialService({
      credentialStore: new MemoryCredentialStore() as never,
      eventService: targetedOpenEventService(vi.fn()) as never,
      approvalQueue: approvingQueue() as never,
    });
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };

    await expect(
      service.handler(ctx, "connect", [
        {
          flow: {
            type: "oauth2-auth-code-pkce",
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
        },
      ])
    ).rejects.toThrow(/cannot override state/);
  });

  it("accepts OAuth token responses that omit token_type", async () => {
    const store = new MemoryCredentialStore();
    const emit = vi.fn();
    const service = createCredentialService({
      credentialStore: store as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue() as never,
    });
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };
    const started = await startOAuthConnection(service, emit, ctx, {
      flow: {
        type: "oauth2-auth-code-pkce",
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

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "token",
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    await deliverOAuthCallback(
      started.redirectUri,
      new URLSearchParams({
        code: "code-1",
        state: started.state,
      })
    );
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
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };
    const started = await startOAuthConnection(service, emit, ctx, {
      flow: {
        type: "oauth2-auth-code-pkce",
        authorizeUrl: "https://auth.example.test/oauth/authorize",
        tokenUrl: "https://auth.example.test/oauth/token",
        clientId: "client-1",
      },
      credential: {
        label: "Example OAuth",
        audience: [{ url: "https://api.example.test", match: "origin" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {token}" },
        metadata: {
          accountIdentityJwtClaimRoot: "https://api.example.test/auth",
          accountIdentityJwtClaimField: "account_id",
        },
      },
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: jwtWithPayload({
                "https://api.example.test/auth": { account_id: "acct-from-token" },
              }),
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    await deliverOAuthCallback(
      started.redirectUri,
      new URLSearchParams({
        code: "code-1",
        state: started.state,
      })
    );
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
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };
    const started = await startOAuthConnection(service, emit, ctx, {
      flow: {
        type: "oauth2-auth-code-pkce",
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

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "https://auth.example.test/userinfo") {
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
          return new Response(JSON.stringify({ sub: "acct-userinfo", email: "dev@example.test" }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          JSON.stringify({
            access_token: "token",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );

    await deliverOAuthCallback(
      started.redirectUri,
      new URLSearchParams({
        code: "code-1",
        state: started.state,
      })
    );
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
    const ctx = { caller: verifiedTestCaller("panel-test", "panel") };
    const started = await startOAuthConnection(service, emit, ctx, {
      flow: {
        type: "oauth2-auth-code-pkce",
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
      () => {
        throw new Error("expected OAuth connection to fail");
      },
      (error: Error) => error
    );
    await deliverOAuthCallback(
      started.redirectUri,
      new URLSearchParams({
        code: "code-1",
        state: "wrong",
      })
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET" && !/ECONNRESET/.test(error.message)) throw error;
    });
    expect((await stateError).message).toMatch(/state_mismatch/);

    emit.mockClear();
    const started2 = await startOAuthConnection(service, emit, ctx, {
      flow: {
        type: "oauth2-auth-code-pkce",
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

    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "token",
              token_type: "mac",
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          )
      )
    );

    const tokenTypeError: Promise<Error> = started2.pending.then(
      () => {
        throw new Error("expected OAuth connection to fail");
      },
      (error: Error) => error
    );
    await deliverOAuthCallback(
      started2.redirectUri,
      new URLSearchParams({
        code: "code-1",
        state: started2.state,
      })
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ECONNRESET" && !/ECONNRESET/.test(error.message)) throw error;
    });
    expect((await tokenTypeError).message).toMatch(/bearer token_type/);
  });

  it("connects OAuth2 client credentials through a stored client config", async () => {
    const store = new MemoryCredentialStore();
    const clientConfigStore = new MemoryClientConfigStore();
    await clientConfigStore.save({
      configId: "svc",
      currentVersion: "v1",
      owner: {
        callerId: "worker:test",
        callerKind: "worker",
        repoPath: "worker:test",
        effectiveVersion: "unknown",
      },
      authorizeUrl: "https://auth.example.test/oauth/authorize",
      tokenUrl: "https://auth.example.test/oauth/token",
      status: "active",
      flowTypes: ["oauth2-client-credentials"],
      fields: {
        clientId: { value: "client-1", type: "text", updatedAt: 1 },
        clientSecret: { value: "secret-1", type: "secret", updatedAt: 1 },
      },
      versions: {},
      createdAt: 1,
      updatedAt: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        expect((init?.body as URLSearchParams).get("grant_type")).toBe("client_credentials");
        return new Response(
          JSON.stringify({
            access_token: "service-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );
    const service = createCredentialService({
      credentialStore: store as never,
      clientConfigStore: clientConfigStore as never,
      approvalQueue: approvingQueue("session") as never,
    });
    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "connect",
      [
        {
          flow: {
            type: "oauth2-client-credentials",
            tokenUrl: "https://auth.example.test/oauth/token",
            clientConfigId: "svc",
            tokenAuth: "client_secret_post",
          },
          credential: {
            label: "Service API",
            audience: [{ url: "https://api.example.test/", match: "origin" }],
            injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
          },
        },
      ]
    )) as StoredCredentialSummary;

    expect(stored.id).toBeTruthy();
    expect((await store.loadUrlBound(stored.id))?.accessToken).toBe("service-token");
  });

  it("connects OAuth2 client credentials with private_key_jwt", async () => {
    const store = new MemoryCredentialStore();
    const clientConfigStore = new MemoryClientConfigStore();
    const keyPair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    await clientConfigStore.save({
      configId: "svc-jwt",
      currentVersion: "v1",
      owner: {
        callerId: "worker:test",
        callerKind: "worker",
        repoPath: "worker:test",
        effectiveVersion: "unknown",
      },
      authorizeUrl: "https://auth.example.test/oauth/authorize",
      tokenUrl: "https://auth.example.test/oauth/token",
      status: "active",
      flowTypes: ["oauth2-client-credentials"],
      fields: {
        clientId: { value: "client-1", type: "text", updatedAt: 1 },
        privateKeyPem: { value: keyPair.privateKey, type: "secret", updatedAt: 1 },
        keyId: { value: "kid-1", type: "text", updatedAt: 1 },
      },
      versions: {},
      createdAt: 1,
      updatedAt: 1,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        const body = init?.body as URLSearchParams;
        expect(body.get("client_assertion_type")).toBe(
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
        );
        expect(body.get("client_assertion")?.split(".")).toHaveLength(3);
        expect(body.get("client_secret")).toBeNull();
        return new Response(
          JSON.stringify({
            access_token: "service-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );
    const service = createCredentialService({
      credentialStore: store as never,
      clientConfigStore: clientConfigStore as never,
      approvalQueue: approvingQueue("session") as never,
    });
    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "connect",
      [
        {
          flow: {
            type: "oauth2-client-credentials",
            tokenUrl: "https://auth.example.test/oauth/token",
            clientConfigId: "svc-jwt",
            tokenAuth: "private_key_jwt",
          },
          credential: {
            label: "Service API",
            audience: [{ url: "https://api.example.test/", match: "origin" }],
            injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
          },
        },
      ]
    )) as StoredCredentialSummary;

    expect((await store.loadUrlBound(stored.id))?.metadata?.["oauthTokenAuth"]).toBe(
      "private_key_jwt"
    );
    expect(JSON.stringify(stored)).not.toContain("PRIVATE KEY");
  });

  it("authenticates device authorization requests with private_key_jwt", async () => {
    const store = new MemoryCredentialStore();
    const clientConfigStore = new MemoryClientConfigStore();
    const keyPair = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    await clientConfigStore.save({
      configId: "device-jwt",
      currentVersion: "v1",
      owner: {
        callerId: "panel-test",
        callerKind: "panel",
        repoPath: "panel-test",
        effectiveVersion: "unknown",
      },
      authorizeUrl: "https://auth.example.test/device",
      tokenUrl: "https://auth.example.test/token",
      status: "active",
      flowTypes: ["oauth2-device-code"],
      fields: {
        clientId: { value: "client-1", type: "text", updatedAt: 1 },
        privateKeyPem: { value: keyPair.privateKey, type: "secret", updatedAt: 1 },
      },
      versions: {},
      createdAt: 1,
      updatedAt: 1,
    });
    const emit = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = init?.body as URLSearchParams;
        expect(body.get("client_assertion_type")).toBe(
          "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
        );
        expect(body.get("client_assertion")?.split(".")).toHaveLength(3);
        expect(body.get("client_secret")).toBeNull();
        if (url === "https://auth.example.test/device") {
          return new Response(
            JSON.stringify({
              device_code: "device-1",
              user_code: "USR-CODE",
              verification_uri: "https://auth.example.test/verify",
              interval: 1,
              expires_in: 5,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify({
            access_token: "device-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      })
    );
    const service = createCredentialService({
      credentialStore: store as never,
      clientConfigStore: clientConfigStore as never,
      eventService: targetedOpenEventService(emit) as never,
      approvalQueue: approvingQueue("session") as never,
    });

    const stored = (await service.handler(
      { caller: verifiedTestCaller("panel-test", "panel") },
      "connect",
      [
        {
          flow: {
            type: "oauth2-device-code",
            deviceAuthorizationUrl: "https://auth.example.test/device",
            tokenUrl: "https://auth.example.test/token",
            clientConfigId: "device-jwt",
            tokenAuth: "private_key_jwt",
            pollIntervalSeconds: 1,
          },
          credential: {
            label: "Device API",
            audience: [{ url: "https://api.example.test/", match: "origin" }],
            injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
          },
        },
      ]
    )) as StoredCredentialSummary;

    expect(stored.id).toBeTruthy();
    expect((await store.loadUrlBound(stored.id))?.accessToken).toBe("device-token");
  });

  it("surfaces the user_code via presentDeviceCode and cancels polling when the user dismisses", async () => {
    const store = new MemoryCredentialStore();
    const clientConfigStore = new MemoryClientConfigStore();
    await clientConfigStore.save({
      configId: "device-cancel",
      currentVersion: "v1",
      owner: {
        callerId: "panel-test",
        callerKind: "panel",
        repoPath: "panel-test",
        effectiveVersion: "unknown",
      },
      authorizeUrl: "https://auth.example.test/device",
      tokenUrl: "https://auth.example.test/token",
      status: "active",
      flowTypes: ["oauth2-device-code"],
      fields: { clientId: { value: "client-1", type: "text", updatedAt: 1 } },
      versions: {},
      createdAt: 1,
      updatedAt: 1,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "https://auth.example.test/device") {
          return new Response(
            JSON.stringify({
              device_code: "device-2",
              user_code: "ABCD-1234",
              verification_uri: "https://auth.example.test/verify",
              interval: 1,
              expires_in: 60,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        // Provider never grants — would poll until cancelled or expired.
        return new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      })
    );

    const presentDeviceCode = vi.fn();
    const controller = new AbortController();
    let approvalId = "";
    const customQueue = {
      ...approvingQueue("session"),
      presentDeviceCode: vi.fn((req: unknown) => {
        presentDeviceCode(req);
        approvalId = "device-code-1";
        return {
          approvalId,
          cancelled: controller.signal,
          dispose: vi.fn(),
        };
      }),
    };
    const service = createCredentialService({
      credentialStore: store as never,
      clientConfigStore: clientConfigStore as never,
      eventService: targetedOpenEventService(vi.fn()) as never,
      approvalQueue: customQueue as never,
    });

    const pending = service.handler(
      { caller: verifiedTestCaller("panel-test", "panel") },
      "connect",
      [
        {
          flow: {
            type: "oauth2-device-code",
            deviceAuthorizationUrl: "https://auth.example.test/device",
            tokenUrl: "https://auth.example.test/token",
            clientConfigId: "device-cancel",
            pollIntervalSeconds: 1,
          },
          credential: {
            label: "Device API",
            audience: [{ url: "https://api.example.test/", match: "origin" }],
            injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
          },
        },
      ]
    ) as Promise<StoredCredentialSummary>;

    await vi.waitFor(() => expect(presentDeviceCode).toHaveBeenCalled());
    const presented = presentDeviceCode.mock.calls[0]![0] as {
      userCode: string;
      verificationUri: string;
      credentialLabel: string;
    };
    expect(presented.userCode).toBe("ABCD-1234");
    expect(presented.verificationUri).toBe("https://auth.example.test/verify");
    expect(presented.credentialLabel).toBe("Device API");

    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: "approval_denied" });
  });

  it("connects AWS SigV4 credentials through host-owned input", async () => {
    const store = new MemoryCredentialStore();
    const approvalQueue = approvingQueue("session");
    approvalQueue.requestCredentialInput = vi.fn(async () => ({
      decision: "submit" as const,
      values: {
        accessKeyId: "AKIATEST",
        secretAccessKey: "aws-secret",
        sessionToken: "session-token",
      },
    })) as never;
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvalQueue as never,
    });
    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "connect",
      [
        {
          flow: { type: "aws-sigv4" },
          credential: {
            label: "AWS",
            audience: [{ url: "https://s3.us-east-1.amazonaws.com/", match: "origin" }],
            injection: { type: "aws-sigv4", service: "s3", region: "us-east-1" },
          },
        },
      ]
    )) as StoredCredentialSummary;

    const persisted = await store.loadUrlBound(stored.id);
    expect(persisted?.accessToken).toBe("AKIATEST");
    expect(persisted?.awsSecretAccessKey).toBe("aws-secret");
    expect(JSON.stringify(stored)).not.toContain("aws-secret");
  });

  it("generates SSH key credentials for git-ssh bindings", async () => {
    const store = new MemoryCredentialStore();
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvingQueue("session") as never,
    });
    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "connect",
      [
        {
          flow: { type: "ssh-key" },
          credential: {
            label: "Git SSH",
            audience: [{ url: "https://github.com/example/repo", match: "path-prefix" }],
            injection: { type: "ssh-key" },
            bindings: [
              {
                id: "git",
                use: "git-ssh",
                audience: [{ url: "https://github.com/example/repo", match: "path-prefix" }],
                injection: { type: "ssh-key" },
              },
            ],
          },
        },
      ]
    )) as StoredCredentialSummary;

    const persisted = await store.loadUrlBound(stored.id);
    expect(persisted?.sshPrivateKey).toContain("PRIVATE KEY");
    expect(persisted?.sshPublicKey).toMatch(/^ssh-ed25519 /);
    expect(stored.metadata?.["sshPublicKeyFingerprint"]).toMatch(/^SHA256:/);
    expect(JSON.stringify(stored)).not.toContain("PRIVATE KEY");
  });

  it("stores captured browser cookie sessions through the platform capture hook", async () => {
    const store = new MemoryCredentialStore();
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvingQueue("session") as never,
      sessionCredentialCapture: {
        captureCookies: vi.fn(async () => ({
          cookieHeader: "sid=secret",
          expiresAt: Date.now() + 60_000,
        })),
      },
    });
    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "connect",
      [
        {
          flow: {
            type: "browser-cookie-session",
            signInUrl: "https://app.example.test/login",
            capture: {
              cookies: ["sid"],
              origins: ["https://app.example.test"],
            },
          },
          credential: {
            label: "App session",
            audience: [{ url: "https://app.example.test/", match: "origin" }],
            injection: { type: "cookie" },
          },
          browser: "external",
        },
      ]
    )) as StoredCredentialSummary;

    expect(stored.injection).toEqual({ type: "cookie" });
    expect((await store.loadUrlBound(stored.id))?.cookieHeader).toBe("sid=secret");
    expect(JSON.stringify(stored)).not.toContain("sid=secret");
    expect(service as never).toBeTruthy();
  });

  it("stores SAML browser sessions captured as scoped cookies", async () => {
    const store = new MemoryCredentialStore();
    const service = createCredentialService({
      credentialStore: store as never,
      approvalQueue: approvingQueue("session") as never,
      sessionCredentialCapture: {
        captureCookies: vi.fn(),
        captureSamlSession: vi.fn(async () => ({
          cookieHeader: "saml_sid=secret",
          cookieSession: {
            origins: ["https://idp.example.test"],
            cookies: [
              {
                name: "saml_sid",
                value: "secret",
                domain: "sp.example.test",
                path: "/",
                secure: true,
              },
            ],
          },
          expiresAt: Date.now() + 60_000,
        })),
      },
    });
    const stored = (await service.handler(
      { caller: verifiedTestCaller("worker:test", "worker") },
      "connect",
      [
        {
          flow: {
            type: "saml-browser-session",
            signInUrl: "https://idp.example.test/login",
            spAudience: "https://sp.example.test/metadata",
            capture: { cookies: ["saml_sid"] },
          },
          credential: {
            label: "SAML session",
            audience: [{ url: "https://sp.example.test/", match: "origin" }],
            injection: { type: "cookie" },
          },
          browser: "internal",
        },
      ]
    )) as StoredCredentialSummary;

    const persisted = await store.loadUrlBound(stored.id);
    expect(persisted?.cookieHeader).toBe("saml_sid=secret");
    expect(persisted?.cookieSession?.cookies[0]?.name).toBe("saml_sid");
    expect(JSON.stringify(stored)).not.toContain("saml_sid=secret");
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
      } satisfies AuditEntry
    );
    const service = createCredentialService({ auditLog: auditLog as never });
    const entries = (await service.handler(
      { caller: verifiedTestCaller("shell", "shell") },
      "audit",
      [{}]
    )) as AuditEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.method).toBe("GET");
  });
});
