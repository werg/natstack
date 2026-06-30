import { describe, expect, it } from "vitest";
import {
  type ConnectPairing,
  createConnectDeepLink,
  isLoopbackHost,
  isSelectedWorkspaceUrl,
  normalizeFingerprint,
  parseConnectLink,
  parseConnectServerUrl,
  parseSignalingEndpoint,
  selectedWorkspaceNameFromUrl,
  selectedWorkspaceUrl,
  serverCdpHostWsUrl,
  serverRpcHttpUrl,
  serverRpcStreamHttpUrl,
  serverRpcWsUrl,
} from "./connect";

const FP = "AA".repeat(32); // 64 hex chars = a SHA-256
const PAIR: ConnectPairing = {
  room: "11111111-2222-3333-4444-555555555555",
  fp: FP,
  code: "A".repeat(24),
  sig: "wss://signal.example/",
  v: 1,
  ice: "all",
};

describe("connect deep links (WebRTC pairing grammar)", () => {
  it("round-trips a pairing link", () => {
    const link = createConnectDeepLink(PAIR);
    expect(parseConnectLink(link)).toEqual({
      kind: "ok",
      room: PAIR.room,
      fp: PAIR.fp,
      code: PAIR.code,
      sig: "wss://signal.example/",
      v: 1,
      ice: "all",
      srv: undefined,
    });
  });

  it("carries the optional srv label and relay policy", () => {
    const link = createConnectDeepLink({ ...PAIR, srv: "home", ice: "relay" });
    const parsed = parseConnectLink(link);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.srv).toBe("home");
      expect(parsed.ice).toBe("relay");
    }
  });

  it("does not rely on URL support for the natstack custom scheme (RN/Hermes)", () => {
    // The parser must NOT call new URL() on a natstack: link. Simulate a runtime
    // where URL throws for the custom scheme; parsing must still succeed (it only
    // URL-parses the real `sig` endpoint, never the natstack: link itself).
    const RealURL = URL;
    function StubURL(this: unknown, input: string | URL, base?: string | URL): URL {
      if (String(input).startsWith("natstack:")) throw new Error("URL protocol not implemented");
      return base === undefined ? new RealURL(input) : new RealURL(input, base);
    }
    const original = globalThis.URL;
    globalThis.URL = StubURL as unknown as typeof URL;
    try {
      expect(parseConnectLink(createConnectDeepLink(PAIR)).kind).toBe("ok");
    } finally {
      globalThis.URL = original;
    }
  });

  it("rejects a link missing required params", () => {
    expect(parseConnectLink("natstack://connect?room=abcdefgh&fp=" + FP).kind).toBe("error");
    expect(parseConnectLink("natstack://connect?room=abcdefgh").kind).toBe("error");
  });

  it("rejects a fingerprint that is not a SHA-256", () => {
    const bad = parseConnectLink(createConnectDeepLink({ ...PAIR, fp: "DE:AD:BE:EF" }));
    expect(bad).toEqual({ kind: "error", reason: "DTLS fingerprint must be a SHA-256 (64 hex chars)" });
  });

  it("accepts a colon-delimited fingerprint and normalizes for comparison", () => {
    const colons = FP.match(/.{2}/g)!.join(":");
    const parsed = parseConnectLink(createConnectDeepLink({ ...PAIR, fp: colons }));
    expect(parsed.kind).toBe("ok");
    expect(normalizeFingerprint(colons)).toBe(FP.toUpperCase());
  });

  it("rejects malformed pairing codes", () => {
    expect(parseConnectLink(createConnectDeepLink({ ...PAIR, code: "short" }))).toEqual({
      kind: "error",
      reason: "Pairing code has an unexpected format",
    });
  });

  it("rejects a cleartext signaling endpoint on a public host", () => {
    expect(parseConnectLink(createConnectDeepLink({ ...PAIR, sig: "ws://signal.example/" })).kind).toBe("error");
  });

  it("allows a loopback cleartext signaling endpoint for dev", () => {
    expect(parseConnectLink(createConnectDeepLink({ ...PAIR, sig: "ws://127.0.0.1:8787/" })).kind).toBe("ok");
  });

  it("validates the signaling endpoint scheme directly", () => {
    expect(parseSignalingEndpoint("wss://x/").kind).toBe("ok");
    expect(parseSignalingEndpoint("ftp://x/").kind).toBe("error");
    expect(parseSignalingEndpoint("ws://example.com/").kind).toBe("error");
  });

  describe("isLoopbackHost (replaces isTrustedCleartextHost — loopback only)", () => {
    it("trusts loopback and the Android emulator alias", () => {
      for (const h of ["localhost", "127.0.0.1", "127.1.2.3", "10.0.2.2", "::1"]) {
        expect(isLoopbackHost(h), h).toBe(true);
      }
    });
    it("does NOT trust LAN, Tailscale, .local, single-label, or spoofed-loopback hosts", () => {
      for (const h of [
        "192.168.1.20", // private LAN — no longer trusted (data plane is WebRTC)
        "100.64.1.20", // Tailscale CGNAT — decommissioned
        "box.local",
        "single-label-host",
        "127.evil.com", // sub-label spoof
        "127.0.0.1.evil.com",
        "example.com",
      ]) {
        expect(isLoopbackHost(h), h).toBe(false);
      }
    });
  });

  // The CLI ships a dependency-free Node mirror of this grammar in
  // scripts/cli/lib/connect-utils.mjs (raw `node`, no workspace deps). It MUST
  // stay byte-identical in behavior to connect.ts; these tests pin the lockstep.
  // The mirror is plain JS with no .d.ts, so import it via a runtime URL + cast
  // (a static specifier would trip TS7016 / implicit-any).
  type ConnectUtilsMirror = {
    createConnectDeepLink: (pairing: ConnectPairing) => string;
    parseConnectLink: (raw: string) => unknown;
    parseConnectServerUrl: (raw: string) => unknown;
    parseSignalingEndpoint: (raw: string) => unknown;
    normalizeFingerprint: (fp: string) => string;
    isLoopbackHost: (host: string) => boolean;
  };
  const loadMirror = async (): Promise<ConnectUtilsMirror> => {
    const scriptUrl = new URL("../../../scripts/cli/lib/connect-utils.mjs", import.meta.url);
    return (await import(scriptUrl.href)) as ConnectUtilsMirror;
  };

  describe("scripts/cli/lib/connect-utils.mjs parity (new WebRTC grammar)", () => {
    it("mints and round-trips an identical deep link", async () => {
      const mirror = await loadMirror();
      const link = createConnectDeepLink(PAIR);
      expect(mirror.createConnectDeepLink(PAIR)).toBe(link);
      expect(mirror.parseConnectLink(link)).toEqual(parseConnectLink(link));
      const withSrv = createConnectDeepLink({ ...PAIR, srv: "home", ice: "relay" });
      expect(mirror.createConnectDeepLink({ ...PAIR, srv: "home", ice: "relay" })).toBe(withSrv);
      expect(mirror.parseConnectLink(withSrv)).toEqual(parseConnectLink(withSrv));
    });

    it("rejects the same malformed links the shared parser rejects", async () => {
      const mirror = await loadMirror();
      for (const bad of [
        "natstack://connect?room=abcdefgh&fp=" + FP,
        createConnectDeepLink({ ...PAIR, fp: "DE:AD:BE:EF" }),
        createConnectDeepLink({ ...PAIR, code: "short" }),
        createConnectDeepLink({ ...PAIR, sig: "ws://signal.example/" }),
      ]) {
        expect(mirror.parseConnectLink(bad)).toEqual(parseConnectLink(bad));
      }
    });

    it("normalizes fingerprints and validates signaling endpoints identically", async () => {
      const mirror = await loadMirror();
      const colons = FP.match(/.{2}/g)!.join(":");
      expect(mirror.normalizeFingerprint(colons)).toBe(normalizeFingerprint(colons));
      for (const sig of ["wss://x/", "ftp://x/", "ws://example.com/", "ws://127.0.0.1:8787/"]) {
        expect(mirror.parseSignalingEndpoint(sig)).toEqual(parseSignalingEndpoint(sig));
      }
    });

    it("gates cleartext server origins on loopback identically", async () => {
      const mirror = await loadMirror();
      for (const host of ["localhost", "127.0.0.1", "10.0.2.2", "::1", "192.168.1.20", "box.local", "127.evil.com"]) {
        expect(mirror.isLoopbackHost(host)).toBe(isLoopbackHost(host));
      }
      for (const url of ["http://127.0.0.1:3030", "http://192.168.1.20:3030", "https://server.example", "ftp://x"]) {
        expect(mirror.parseConnectServerUrl(url)).toEqual(parseConnectServerUrl(url));
      }
    });
  });
});

describe("server route helpers (unchanged — survive the rewrite)", () => {
  it("builds RPC URLs while preserving selected workspace paths", () => {
    expect(serverRpcHttpUrl("https://server.example").toString()).toBe("https://server.example/rpc");
    expect(serverRpcWsUrl("https://server.example/_workspace/dev")).toBe("wss://server.example/_workspace/dev/rpc");
    expect(serverRpcStreamHttpUrl("http://127.0.0.1:3030/_workspace/dev").toString()).toBe(
      "http://127.0.0.1:3030/_workspace/dev/rpc/stream",
    );
    expect(serverRpcWsUrl("https://server.example/_workspace/rpc")).toBe("wss://server.example/_workspace/rpc/rpc");
  });

  it("builds CDP host URLs while preserving selected workspace paths", () => {
    expect(serverCdpHostWsUrl("https://server.example", "host-a")).toBe(
      "wss://server.example/api/cdp-host?hostConnectionId=host-a",
    );
    expect(serverCdpHostWsUrl("http://127.0.0.1:3030/_workspace/dev/", "host a")).toBe(
      "ws://127.0.0.1:3030/_workspace/dev/api/cdp-host?hostConnectionId=host+a",
    );
  });

  it("builds and parses selected workspace URLs through one shared contract", () => {
    const url = selectedWorkspaceUrl("https://server.example", "dev workspace");
    expect(url.toString()).toBe("https://server.example/_workspace/dev%20workspace");
    expect(selectedWorkspaceNameFromUrl(url)).toBe("dev workspace");
    expect(isSelectedWorkspaceUrl(url)).toBe(true);
    expect(isSelectedWorkspaceUrl("https://server.example/_workspace/dev/rpc")).toBe(false);
  });
});
