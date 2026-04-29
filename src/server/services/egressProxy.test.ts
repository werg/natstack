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
    audience: [{ url: "https://api.example.test/v1", match: "path-prefix" }],
    injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
    allowedCallers: [{ callerId: "worker:test", grantedAt: 1, grantedBy: "self" }],
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
      injection: { type: "query-param", name: "key" },
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

  it("redacts query-param credentials from audit URLs", async () => {
    const auditLog = new MemoryAuditLog();
    const credential = createCredential({
      injection: { type: "query-param", name: "key" },
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
    const credential = createCredential({ allowedCallers: [] });
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
    expect(store.loadUrlBound("cred-1")?.allowedCallers).toEqual([]);
  });
});
