import { describe, it, expect, vi } from "vitest";
import type {
  Credential,
  ProviderManifest,
} from "../../../packages/shared/src/credentials/types.js";
import type { ResolvedCodeIdentity } from "./codeIdentityResolver.js";
import {
  CapabilityBroker,
  detectShape,
  mintTokenForShape,
  isSessionCapability,
} from "./capabilityBroker.js";
import type { ConsentGate } from "./consentGate.js";

function stubManifest(overrides: Partial<ProviderManifest> = {}): ProviderManifest {
  return {
    id: "test-provider",
    displayName: "Test",
    apiBase: ["https://api.test.com"],
    flows: [],
    authInjection: { type: "header", headerName: "authorization", valueTemplate: "Bearer {token}" },
    ...overrides,
  };
}

function stubCredential(overrides: Partial<Credential> = {}): Credential {
  return {
    providerId: "test-provider",
    connectionId: "conn-1",
    connectionLabel: "Test",
    accountIdentity: { providerUserId: "user-1" },
    accessToken: "raw-token-bytes",
    scopes: ["a"],
    ...overrides,
  };
}

function makeBroker(overrides: {
  manifest?: ProviderManifest;
  credential?: Credential;
  gateError?: { statusCode: number; message: string; code?: string };
} = {}) {
  const manifest = overrides.manifest ?? stubManifest();
  const credential = overrides.credential ?? stubCredential();

  const consentGate = {
    ensureGrant: vi.fn(async () => {
      if (overrides.gateError) return { error: overrides.gateError };
      return {
        grant: {
          codeIdentity: "hash-x",
          codeIdentityType: "hash" as const,
          providerId: manifest.id,
          connectionId: credential.connectionId,
          scopes: credential.scopes,
          grantedAt: Date.now(),
          grantedBy: "caller-1",
        },
        credential,
      };
    }),
  } as unknown as ConsentGate;

  const credentialStore = {
    load: vi.fn(async () => credential),
    list: vi.fn(async () => [credential]),
  };
  const identity: ResolvedCodeIdentity = {
    callerId: "caller-1",
    callerKind: "worker",
    repoPath: "/repo",
    effectiveVersion: "v1",
  };
  const broker = new CapabilityBroker({
    credentialStore,
    consentGate,
    resolveIdentity: () => identity,
  });
  return { broker, manifest, credential, consentGate, credentialStore };
}

describe("detectShape", () => {
  it("detects JWT passthrough", () => {
    const jwt = [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify({ sub: "abc" })).toString("base64url"),
      "signature-bytes",
    ].join(".");
    expect(detectShape({ accessToken: jwt }, {})).toEqual({ kind: "jwt-passthrough" });
  });

  it("detects sk-ant- prefix", () => {
    const shape = detectShape({ accessToken: "sk-ant-api03-abcdefghij" }, {});
    expect(shape.kind).toBe("prefixed-opaque");
    expect(shape.kind === "prefixed-opaque" && shape.prefix).toBe("sk-ant-api03-");
  });

  it("detects sk_live_ prefix", () => {
    const shape = detectShape({ accessToken: "sk_live_abcdefgh" }, {});
    expect(shape.kind).toBe("prefixed-opaque");
    expect(shape.kind === "prefixed-opaque" && shape.prefix).toBe("sk_live_");
  });

  it("detects ghp_ prefix", () => {
    const shape = detectShape({ accessToken: "ghp_abcdefghij" }, {});
    expect(shape.kind).toBe("prefixed-opaque");
    expect(shape.kind === "prefixed-opaque" && shape.prefix).toBe("ghp_");
  });

  it("falls back to opaque for unrecognized tokens", () => {
    const shape = detectShape({ accessToken: "just_a_bare_string" }, {});
    expect(shape.kind).toBe("prefixed-opaque");
  });

  it("falls back to opaque for short tokens with no prefix", () => {
    const shape = detectShape({ accessToken: "ab" }, {});
    expect(shape).toEqual({ kind: "opaque", totalLength: 48 });
  });

  it("uses manifest override when present", () => {
    const override = { kind: "opaque" as const, totalLength: 39 };
    expect(detectShape({ accessToken: "sk-abc" }, { capabilityShape: override })).toEqual(override);
  });
});

describe("mintTokenForShape", () => {
  it("JWT-passthrough preserves header+payload, randomizes signature", () => {
    const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
    })).toString("base64url");
    const source = `${header}.${payload}.real-signature`;
    const minted = mintTokenForShape({ kind: "jwt-passthrough" }, source);
    const parts = minted.split(".");
    expect(parts[0]).toBe(header);
    expect(parts[1]).toBe(payload);
    expect(parts[2]).not.toBe("real-signature");
    const decoded = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    expect(decoded["https://api.openai.com/auth"].chatgpt_account_id).toBe("acct-1");
  });

  it("prefixed-opaque preserves prefix and appends random body", () => {
    const t1 = mintTokenForShape({ kind: "prefixed-opaque", prefix: "sk-ant-" }, "sk-ant-original");
    const t2 = mintTokenForShape({ kind: "prefixed-opaque", prefix: "sk-ant-" }, "sk-ant-original");
    expect(t1.startsWith("sk-ant-")).toBe(true);
    expect(t1).not.toBe(t2);
  });

  it("opaque uses natstack_cap_ prefix", () => {
    const t = mintTokenForShape({ kind: "opaque" }, "source");
    expect(t.startsWith("natstack_cap_")).toBe(true);
  });
});

describe("CapabilityBroker.mintSession", () => {
  it("mints a session capability with natstack_session_ prefix", async () => {
    const { broker } = makeBroker();
    const minted = await broker.mintSession({ callerId: "caller-1" });
    if ("error" in minted) throw new Error("expected success");
    expect(minted.kind).toBe("session");
    expect(isSessionCapability(minted.token)).toBe(true);
    const resolved = broker.resolve(minted.token);
    expect(resolved?.callerId).toBe("caller-1");
    expect(resolved?.kind).toBe("session");
  });
});

describe("CapabilityBroker.mintProvider", () => {
  it("mints a provider capability reflecting the stored credential shape", async () => {
    const jwt = [
      Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
      Buffer.from(JSON.stringify({ sub: "acct-xyz" })).toString("base64url"),
      "sig",
    ].join(".");
    const { broker } = makeBroker({ credential: stubCredential({ accessToken: jwt }) });

    const minted = await broker.mintProvider({ callerId: "caller-1", provider: stubManifest() });
    if ("error" in minted) throw new Error("expected success");
    const parts = minted.token.split(".");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(jwt.split(".")[0]);
    expect(parts[1]).toBe(jwt.split(".")[1]);

    const resolved = broker.resolve(minted.token);
    expect(resolved?.kind).toBe("provider");
    expect(resolved?.providerId).toBe("test-provider");
    expect(resolved?.connectionId).toBe("conn-1");
  });

  it("returns an error when consentGate denies", async () => {
    const { broker } = makeBroker({
      gateError: { statusCode: 403, message: "denied", code: "CONSENT_DENIED" },
    });
    const result = await broker.mintProvider({ callerId: "caller-1", provider: stubManifest() });
    expect("error" in result && result.error.statusCode).toBe(403);
    expect("error" in result && result.error.code).toBe("CONSENT_DENIED");
  });
});

describe("CapabilityBroker.revokeFor", () => {
  it("invalidates provider capabilities on bumping the grant epoch", async () => {
    const { broker } = makeBroker();
    const minted = await broker.mintProvider({ callerId: "caller-1", provider: stubManifest() });
    if ("error" in minted) throw new Error("expected success");
    expect(broker.resolve(minted.token)).not.toBeNull();

    broker.revokeFor("test-provider", "conn-1");
    expect(broker.resolve(minted.token)).toBeNull();
  });
});

describe("CapabilityBroker.resolveFromRequest", () => {
  it("finds a capability in Authorization header", async () => {
    const { broker } = makeBroker();
    const minted = await broker.mintSession({ callerId: "caller-1" });
    if ("error" in minted) throw new Error("expected success");
    const hit = broker.resolveFromRequest({ authorization: `Bearer ${minted.token}` });
    expect(hit?.entry.callerId).toBe("caller-1");
    expect(hit?.carrier).toEqual({ kind: "header", name: "authorization" });
  });

  it("finds a capability in a manifest's custom header slot (x-api-key)", async () => {
    const manifest = stubManifest({
      id: "anthropic-like",
      authInjection: { type: "header", headerName: "x-api-key", valueTemplate: "{token}" },
    });
    const { broker } = makeBroker({ manifest });
    const minted = await broker.mintProvider({ callerId: "caller-1", provider: manifest });
    if ("error" in minted) throw new Error("expected success");
    const hit = broker.resolveFromRequest({ "x-api-key": minted.token });
    expect(hit?.carrier).toEqual({ kind: "header", name: "x-api-key" });
  });

  it("finds a capability in a URL query param slot", async () => {
    const manifest = stubManifest({
      id: "google-like",
      authInjection: { type: "query-param", paramName: "key" },
    });
    const { broker } = makeBroker({ manifest });
    const minted = await broker.mintProvider({ callerId: "caller-1", provider: manifest });
    if ("error" in minted) throw new Error("expected success");
    const hit = broker.resolveFromRequest({}, `https://example.com/?key=${encodeURIComponent(minted.token)}`);
    expect(hit?.carrier).toEqual({ kind: "query", name: "key" });
  });

  it("returns null for forged tokens", () => {
    const { broker } = makeBroker();
    expect(broker.resolveFromRequest({ authorization: "Bearer natstack_cap_forged" })).toBeNull();
  });
});

describe("CapabilityBroker TTL sweep", () => {
  it("drops expired entries on resolve", async () => {
    const { broker } = makeBroker();
    const minted = await broker.mintSession({ callerId: "caller-1", ttlSeconds: 0 });
    if ("error" in minted) throw new Error("expected success");
    // ttlSeconds 0 → ttlMs 0 → expiresAt = now, so resolve should drop it.
    await new Promise((r) => setTimeout(r, 5));
    expect(broker.resolve(minted.token)).toBeNull();
  });
});
