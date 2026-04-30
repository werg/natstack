import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditEntry, Credential } from "../../../packages/shared/src/credentials/types.js";
import { EgressProxy } from "./egressProxy.js";
import { CredentialSessionGrantStore } from "./credentialSessionGrants.js";

class MemoryCredentialStore {
  constructor(private readonly credentials = new Map<string, Credential>()) {}

  loadUrlBound(id: string): Credential | null {
    return this.credentials.get(id) ?? null;
  }

  saveUrlBound(credential: Credential & { id: string }): void {
    this.credentials.set(credential.id, credential);
  }
}

class MemoryAuditLog {
  readonly entries: AuditEntry[] = [];

  append(entry: AuditEntry): void {
    this.entries.push(entry);
  }
}

function createCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    id: "cred-1",
    label: "Example",
    owner: { sourceId: "/repo", sourceKind: "workspace", label: "/repo" },
    bindings: [{
      id: "api",
      use: "fetch",
      audience: [{ url: "https://api.example.test/v1", match: "path-prefix" }],
      injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
    }],
    grants: [{
      bindingId: "api",
      use: "fetch",
      resource: "https://api.example.test/v1",
      action: "use",
      scope: "caller",
      callerId: "worker:test",
      grantedAt: 1,
      grantedBy: "self",
    }],
    providerId: "url-bound",
    connectionId: "cred-1",
    connectionLabel: "Example",
    accountIdentity: { providerUserId: "acct-1" },
    accessToken: "secret-token",
    scopes: ["read"],
    ...overrides,
  };
}

function createProxy(credential = createCredential(), auditLog = new MemoryAuditLog()): EgressProxy {
  return new EgressProxy({
    credentialStore: new MemoryCredentialStore(new Map([[credential.id ?? credential.connectionId, credential]])),
    auditLog: auditLog as never,
    codeIdentityResolver: {
      resolveByCallerId: (callerId: string) => callerId === "worker:test"
        ? { callerId, callerKind: "worker", repoPath: "/repo", effectiveVersion: "hash-1" }
        : null,
    },
  });
}

describe("EgressProxy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("injects URL-bound credentials and strips incoming credential carriers", () => {
    const proxy = createProxy();
    const prepared = proxy.prepareForwardRequest(
      new URL("https://api.example.test/v1/items"),
      {
        Authorization: "Bearer attacker",
        "x-api-key": "attacker",
        "x-safe": "keep",
        Connection: "close",
      },
      createCredential(),
    );

    expect(prepared.targetUrl.toString()).toBe("https://api.example.test/v1/items");
    expect(prepared.headers).toMatchObject({
      authorization: "Bearer secret-token",
      "x-safe": "keep",
      host: "api.example.test",
    });
    expect(prepared.headers["x-api-key"]).toBeUndefined();
    expect(prepared.headers.connection).toBeUndefined();
  });

  it("injects query-param credentials by replacing any incoming value", () => {
    const credential = createCredential({
      bindings: [{
        id: "api",
        use: "fetch",
        audience: [{ url: "https://api.example.test/v1", match: "path-prefix" }],
        injection: { type: "query-param", name: "key" },
      }],
      grants: [{
        bindingId: "github-git",
        use: "git-http",
        resource: "https://github.com/acme/project.git",
        action: "read",
        scope: "caller",
        callerId: "worker:test",
        grantedAt: 1,
        grantedBy: "self",
      }],
    });
    const proxy = createProxy(credential);
    const prepared = proxy.prepareForwardRequest(
      new URL("https://api.example.test/v1/items?key=attacker&x=1"),
      { authorization: "Bearer attacker" },
      credential,
    );

    expect(prepared.targetUrl.toString()).toBe("https://api.example.test/v1/items?x=1&key=secret-token");
    expect(prepared.headers.authorization).toBeUndefined();
  });

  it("injects basic auth credentials for git-http bindings", () => {
    const credential = createCredential({
      bindings: [{
        id: "github-git",
        use: "git-http",
        audience: [{ url: "https://github.com/", match: "origin" }],
        injection: {
          type: "basic-auth",
          usernameTemplate: "x-access-token",
          passwordTemplate: "{token}",
        },
      }],
      grants: [{
        bindingId: "github-git",
        use: "git-http",
        resource: "https://github.com/acme/project.git",
        action: "read",
        scope: "caller",
        callerId: "worker:test",
        grantedAt: 1,
        grantedBy: "self",
      }],
    });
    const proxy = createProxy(credential);
    const prepared = proxy.prepareForwardRequest(
      new URL("https://github.com/acme/project.git/info/refs?service=git-upload-pack"),
      { authorization: "Bearer attacker" },
      credential,
      credential.bindings![0],
    );

    expect(prepared.headers.authorization).toBe("Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0LXRva2Vu");
  });

  it("redacts query-param credentials from audit URLs", async () => {
    const auditLog = new MemoryAuditLog();
    const credential = createCredential({
      bindings: [{
        id: "api",
        use: "fetch",
        audience: [{ url: "https://api.example.test/v1", match: "path-prefix" }],
        injection: { type: "query-param", name: "key" },
      }],
    });
    const proxy = createProxy(credential, auditLog);
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL) =>
      new Response("ok", { status: 200, statusText: "OK" })
    ));

    await proxy.forwardProxyFetch({
      callerId: "worker:test",
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items?key=attacker&x=1",
      method: "GET",
    });

    expect(String(fetch).includes("secret-token")).toBe(false);
    expect(auditLog.entries[0]?.url).toBe("https://api.example.test/v1/items?key=%5Bredacted%5D&x=1");
    expect(JSON.stringify(auditLog.entries)).not.toContain("secret-token");
  });

  it("forwards fetches through matching URL-bound credentials", async () => {
    const auditLog = new MemoryAuditLog();
    const proxy = createProxy(createCredential(), auditLog);
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe("https://api.example.test/v1/items");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
      return new Response("ok", { status: 200, statusText: "OK" });
    }));

    const response = await proxy.forwardProxyFetch({
      callerId: "worker:test",
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
      headers: { authorization: "Bearer attacker" },
    });

    expect(response).toMatchObject({ status: 200, body: "ok" });
    expect(auditLog.entries[0]).toMatchObject({
      callerId: "worker:test",
      providerId: "url-bound",
      connectionId: "cred-1",
      status: 200,
      scopesUsed: ["read"],
    });
  });

  it("forwards git HTTP requests through git-http bindings", async () => {
    const auditLog = new MemoryAuditLog();
    const credential = createCredential({
      bindings: [{
        id: "github-git",
        use: "git-http",
        audience: [{ url: "https://github.com/", match: "origin" }],
        injection: {
          type: "basic-auth",
          usernameTemplate: "x-access-token",
          passwordTemplate: "{token}",
        },
      }],
      grants: [{
        bindingId: "github-git",
        use: "git-http",
        resource: "https://github.com/acme/project.git",
        action: "read",
        scope: "caller",
        callerId: "worker:test",
        grantedAt: 1,
        grantedBy: "self",
      }],
    });
    const proxy = createProxy(credential, auditLog);
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(_input)).toBe("https://github.com/acme/project.git/git-upload-pack");
      expect(new Headers(init?.headers).get("authorization")).toBe("Basic eC1hY2Nlc3MtdG9rZW46c2VjcmV0LXRva2Vu");
      const body = new Uint8Array(await new Response(init?.body).arrayBuffer());
      expect(Array.from(body)).toEqual([1, 2, 3]);
      return new Response(new Uint8Array([4, 5]), { status: 200, statusText: "OK" });
    }));

    const response = await proxy.forwardGitHttp({
      callerId: "worker:test",
      credentialId: "cred-1",
      url: "https://github.com/acme/project.git/git-upload-pack",
      method: "POST",
      headers: { authorization: "Bearer attacker" },
      body: new Uint8Array([1, 2, 3]),
    });

    expect(Array.from(response.body)).toEqual([4, 5]);
    expect(auditLog.entries[0]).toMatchObject({
      callerId: "worker:test",
      connectionId: "cred-1",
      method: "POST",
      status: 200,
    });
  });

  it("requests git-specific approval copy metadata for git HTTP writes", async () => {
    const credential = createCredential({
      grants: [],
      bindings: [{
        id: "github-git",
        use: "git-http",
        audience: [{ url: "https://github.com/", match: "origin" }],
        injection: {
          type: "basic-auth",
          usernameTemplate: "x-access-token",
          passwordTemplate: "{token}",
        },
      }],
    });
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const proxy = new EgressProxy({
      credentialStore: new MemoryCredentialStore(new Map([[credential.id!, credential]])),
      auditLog: new MemoryAuditLog() as never,
      approvalQueue: approvalQueue as never,
      codeIdentityResolver: {
        resolveByCallerId: () => ({
          callerId: "worker:test",
          callerKind: "worker",
          repoPath: "/repo",
          effectiveVersion: "hash-1",
        }),
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(), { status: 200, statusText: "OK" })));

    await proxy.forwardGitHttp({
      callerId: "worker:test",
      credentialId: "cred-1",
      url: "https://github.com/acme/project.git/git-receive-pack",
      method: "POST",
    });

    expect(approvalQueue.request).toHaveBeenCalledWith(expect.objectContaining({
      credentialUse: "git-http",
      gitOperation: {
        action: "write",
        label: "git push",
        remote: "https://github.com/acme/project.git",
        service: "git-receive-pack",
      },
    }));
  });

  it("retries replay-safe retryable responses and records retry count", async () => {
    const auditLog = new MemoryAuditLog();
    const proxy = createProxy(createCredential(), auditLog);
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return calls === 1
        ? new Response("busy", { status: 503, statusText: "Service Unavailable" })
        : new Response("ok", { status: 200, statusText: "OK" });
    }));

    const response = await proxy.forwardProxyFetch({
      callerId: "worker:test",
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });

    expect(response.status).toBe(200);
    expect(calls).toBe(2);
    expect(auditLog.entries[0]).toMatchObject({ retries: 1, breakerState: "closed" });
  });

  it("rejects audience and caller mismatches before forwarding", async () => {
    const proxy = createProxy();
    vi.stubGlobal("fetch", vi.fn());

    await expect(proxy.forwardProxyFetch({
      callerId: "worker:test",
      credentialId: "cred-1",
      url: "https://api.example.test/v2/items",
      method: "GET",
    })).rejects.toThrow(/credential-audience-mismatch/);

    await expect(proxy.forwardProxyFetch({
      callerId: "worker:other",
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    })).rejects.toThrow(/credential-caller-not-granted/);

    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps session grants in memory across callers with the same code version", async () => {
    const credential = createCredential({ grants: [] });
    const store = new MemoryCredentialStore(new Map([[credential.id!, credential]]));
    const approvalQueue = {
      request: vi.fn(async () => "session" as const),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const proxy = new EgressProxy({
      credentialStore: store,
      auditLog: new MemoryAuditLog() as never,
      approvalQueue: approvalQueue as never,
      sessionGrantStore: new CredentialSessionGrantStore(),
      codeIdentityResolver: {
        resolveByCallerId: (callerId: string) => {
          if (callerId === "worker:first" || callerId === "do:worker:first") {
            return { callerId, callerKind: "worker", repoPath: "/repo", effectiveVersion: "hash-1" };
          }
          return null;
        },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200, statusText: "OK" })));

    await proxy.forwardProxyFetch({
      callerId: "worker:first",
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });
    await proxy.forwardProxyFetch({
      callerId: "do:worker:first",
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(store.loadUrlBound("cred-1")?.grants).toEqual([]);
  });

  it.each(["version", "repo"] as const)("reuses persisted %s grants across callers", async (decision) => {
    const credential = createCredential({ grants: [] });
    const store = new MemoryCredentialStore(new Map([[credential.id!, credential]]));
    const approvalQueue = {
      request: vi.fn(async () => decision),
      resolve: vi.fn(),
      listPending: vi.fn(() => []),
    };
    const proxy = new EgressProxy({
      credentialStore: store,
      auditLog: new MemoryAuditLog() as never,
      approvalQueue: approvalQueue as never,
      codeIdentityResolver: {
        resolveByCallerId: (callerId: string) => {
          if (callerId === "worker:first" || callerId === "do:worker:first") {
            return { callerId, callerKind: "worker", repoPath: "/repo", effectiveVersion: "hash-1" };
          }
          return null;
        },
      },
    });
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok", { status: 200, statusText: "OK" })));

    await proxy.forwardProxyFetch({
      callerId: "worker:first",
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });
    await proxy.forwardProxyFetch({
      callerId: "do:worker:first",
      credentialId: "cred-1",
      url: "https://api.example.test/v1/items",
      method: "GET",
    });

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(store.loadUrlBound("cred-1")?.grants).toContainEqual(
      expect.objectContaining({
        bindingId: "api",
        resource: "https://api.example.test/v1",
        action: "use",
        scope: decision,
        repoPath: "/repo",
        grantedBy: decision,
      }),
    );
  });
});
