import { createRequire } from "node:module";
import { describe, expect, it, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { X509Certificate, randomBytes } from "node:crypto";
import {
  Fanout,
  ICE_RESTART_UNSUPPORTED_CODE,
  WrappedPeerConnection,
  canonicalizeFingerprint,
  candidateTypeFromPair,
  createNodeDatachannelProvider,
  fromNodeMessage,
  normalizeCandidateType,
  normalizeConnectionState,
  parseSdpFingerprint,
  pemFingerprint,
  toNodeBuffer,
  toNodeIceServers,
} from "./nodeDatachannelPeer.js";
import { certFileFingerprint, ensurePersistentCert, generateSelfSignedEcCert } from "./cert.js";

// A fixed ECDSA P-256 self-signed cert (generated once with openssl) and its
// pinned SHA-256 fingerprint. This proves localFingerprint is a *stable* offline
// computation — the property the QR pin depends on across server restarts (§11).
const FIXED_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIBhjCCAS2gAwIBAgIUJZsa49NEAVTXHOLNXsRZu2DcXWswCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNbmF0c3RhY2stdGVzdDAgFw0yNjA2MjgxNDQ1MDNaGA8yMTI2
MDYwNDE0NDUwM1owGDEWMBQGA1UEAwwNbmF0c3RhY2stdGVzdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABDTGmGLc0kFpFtowkMJ1ylRennphoJeoQTgBCa8Te8XH
hNb9YIOBuFm5JUEkyDUtxrZet4VDqErqiJafjoVQNxSjUzBRMB0GA1UdDgQWBBTJ
xGL5BJAvxatB8x9eqp0/HYrpgjAfBgNVHSMEGDAWgBTJxGL5BJAvxatB8x9eqp0/
HYrpgjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIBo7LDvM4hU5
kmoTD/MTMd9yabUt5ywadwB8gDFQuT/PAiANi9nNwhZhLK7AYY5eucr9WUZ72w87
Ve0Yp4EvgC/FhA==
-----END CERTIFICATE-----
`;
const FIXED_CERT_FINGERPRINT =
  "F5:A0:FD:65:E2:1B:A2:9B:34:92:BB:6D:64:0E:4F:D3:8D:B5:35:97:13:BE:13:11:06:09:FF:AA:1D:1D:14:3D";

const tmpFiles: string[] = [];
function tmp(name: string): string {
  const file = path.join(os.tmpdir(), `ndc-${randomBytes(6).toString("hex")}-${name}`);
  tmpFiles.push(file);
  return file;
}
afterEach(() => {
  for (const file of tmpFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true, recursive: true });
    } catch {
      /* best effort */
    }
  }
});

describe("Uint8Array <-> Buffer conversion", () => {
  it("toNodeBuffer copies the logical bytes (respecting subarray offset)", () => {
    const backing = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const view = backing.subarray(2, 5); // [2,3,4]
    const buf = toNodeBuffer(view);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect([...buf]).toEqual([2, 3, 4]);
    // Copy semantics: mutating the source must not change the produced Buffer.
    backing[2] = 99;
    expect([...buf]).toEqual([2, 3, 4]);
  });

  it("fromNodeMessage copies binary out of a (poolable) Buffer", () => {
    const source = Buffer.from([10, 20, 30]);
    const out = fromNodeMessage(source);
    expect(out).toBeInstanceOf(Uint8Array);
    expect([...out]).toEqual([10, 20, 30]);
    source[0] = 0; // prove it is a copy, not a view onto native memory
    expect([...out]).toEqual([10, 20, 30]);
  });

  it("fromNodeMessage UTF-8 encodes a text message", () => {
    expect([...fromNodeMessage("AB")]).toEqual([0x41, 0x42]);
    expect([...fromNodeMessage("é")]).toEqual([0xc3, 0xa9]);
  });

  it("round-trips arbitrary bytes send->receive", () => {
    const bytes = new Uint8Array([255, 0, 128, 64, 1]);
    expect([...fromNodeMessage(toNodeBuffer(bytes))]).toEqual([...bytes]);
  });
});

describe("Fanout — single native slot, many listeners", () => {
  it("dispatches to every subscriber with the emitted args", () => {
    const f = new Fanout<[string, number]>();
    const a = vi.fn();
    const b = vi.fn();
    f.add(a);
    f.add(b);
    f.emit("x", 7);
    expect(a).toHaveBeenCalledWith("x", 7);
    expect(b).toHaveBeenCalledWith("x", 7);
    expect(f.size).toBe(2);
  });

  it("the returned unsubscribe removes only that listener", () => {
    const f = new Fanout<[]>();
    const a = vi.fn();
    const b = vi.fn();
    const offA = f.add(a);
    f.add(b);
    offA();
    f.emit();
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(f.size).toBe(1);
  });

  it("isolates a throwing listener so others still run", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = new Fanout<[]>();
    const bad = vi.fn(() => {
      throw new Error("boom");
    });
    const good = vi.fn();
    f.add(bad);
    f.add(good);
    expect(() => f.emit()).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("tolerates a listener unsubscribing during dispatch", () => {
    const f = new Fanout<[]>();
    const order: string[] = [];
    const off2 = f.add(() => {
      order.push("first");
      off2(); // mutate the set mid-emit
    });
    f.add(() => order.push("second"));
    f.emit();
    expect(order).toEqual(["first", "second"]);
  });
});

describe("localFingerprint — stable offline SHA-256 from the PEM", () => {
  it("pemFingerprint matches the pinned value for the fixed cert", () => {
    expect(pemFingerprint(FIXED_CERT_PEM)).toBe(FIXED_CERT_FINGERPRINT);
  });

  it("is stable across repeated computation", () => {
    expect(pemFingerprint(FIXED_CERT_PEM)).toBe(pemFingerprint(FIXED_CERT_PEM));
  });

  it("provider.localFingerprint reads the cert file and returns the pinned value", () => {
    const certFile = tmp("cert.pem");
    fs.writeFileSync(certFile, FIXED_CERT_PEM);
    const provider = createNodeDatachannelProvider();
    expect(provider.localFingerprint?.({ certificatePemFile: certFile })).toBe(
      FIXED_CERT_FINGERPRINT
    );
  });

  it("provider.localFingerprint falls back to the bound default cert path", () => {
    const certFile = tmp("cert.pem");
    fs.writeFileSync(certFile, FIXED_CERT_PEM);
    const provider = createNodeDatachannelProvider({ certificatePemFile: certFile });
    expect(provider.localFingerprint?.({})).toBe(FIXED_CERT_FINGERPRINT);
  });

  it("returns null when no cert is configured (no stable fingerprint to publish)", () => {
    const provider = createNodeDatachannelProvider();
    expect(provider.localFingerprint?.({})).toBeNull();
  });

  it("fails loud (does not mask as null) when a configured cert is malformed", () => {
    const certFile = tmp("bad.pem");
    fs.writeFileSync(certFile, "not a certificate");
    const provider = createNodeDatachannelProvider({ certificatePemFile: certFile });
    expect(() => provider.localFingerprint?.({})).toThrow();
  });
});

describe("native module guard", () => {
  it("importing the module does not load node-datachannel", () => {
    // Reaching this assertion at all proves the top-level import is native-free;
    // the pure provider construction must also stay native-free.
    expect(typeof createNodeDatachannelProvider).toBe("function");
    expect(typeof createNodeDatachannelProvider().localFingerprint).toBe("function");
  });

  // Whether the prebuilt native binary is loadable in THIS environment.
  let nativePresent = false;
  try {
    createRequire(import.meta.url)("node-datachannel");
    nativePresent = true;
  } catch {
    nativePresent = false;
  }

  it.skipIf(nativePresent)(
    "create() fails loud with an actionable message when the addon is absent",
    () => {
      const provider = createNodeDatachannelProvider();
      expect(() => provider.create({ iceServers: [] })).toThrow(
        /node-datachannel native module is unavailable/
      );
    }
  );

  it.runIf(nativePresent)(
    "create() returns a working peer when the native module is present",
    async () => {
      const provider = createNodeDatachannelProvider();
      const pc = await provider.create({ iceServers: [] });
      expect(typeof pc.createDataChannel).toBe("function");
      expect(typeof pc.setLocalDescription).toBe("function");
      expect(typeof pc.remoteFingerprint).toBe("function");
      pc.close();
    }
  );
});

describe("toNodeIceServers — WHATWG -> libdatachannel", () => {
  it("emits STUN as a scheme:host:port string", () => {
    expect(toNodeIceServers([{ urls: "stun:stun.cloudflare.com:3478" }])).toEqual([
      "stun:stun.cloudflare.com:3478",
    ]);
  });

  it("defaults the STUN port to 3478", () => {
    expect(toNodeIceServers([{ urls: "stun:stun.example.com" }])).toEqual([
      "stun:stun.example.com:3478",
    ]);
  });

  it("emits TURN as an object carrying credentials (no URL escaping)", () => {
    expect(
      toNodeIceServers([
        { urls: "turn:turn.example.com:3478", username: "user", credential: "p@ss/+=" },
      ])
    ).toEqual([
      {
        hostname: "turn.example.com",
        port: 3478,
        username: "user",
        password: "p@ss/+=",
        relayType: "TurnUdp",
      },
    ]);
  });

  it("maps transport=tcp and turns: to the right relay type / default port", () => {
    expect(
      toNodeIceServers([
        { urls: "turn:t.example.com:3478?transport=tcp", username: "u", credential: "c" },
      ])
    ).toEqual([
      { hostname: "t.example.com", port: 3478, username: "u", password: "c", relayType: "TurnTcp" },
    ]);
    expect(
      toNodeIceServers([{ urls: "turns:t.example.com", username: "u", credential: "c" }])
    ).toEqual([
      { hostname: "t.example.com", port: 5349, username: "u", password: "c", relayType: "TurnTls" },
    ]);
  });

  it("expands an array of urls and strips IPv6 brackets", () => {
    expect(
      toNodeIceServers([
        {
          urls: ["stun:a.example.com:3478", "turn:[2001:db8::1]:3478"],
          username: "u",
          credential: "c",
        },
      ])
    ).toEqual([
      "stun:a.example.com:3478",
      { hostname: "2001:db8::1", port: 3478, username: "u", password: "c", relayType: "TurnUdp" },
    ]);
  });

  it("throws on an unparseable url rather than silently dropping a relay", () => {
    expect(() => toNodeIceServers([{ urls: "http://not-a-stun-url" }])).toThrow(
      /Unparseable ICE server url/
    );
  });

  it("returns an empty list for no servers", () => {
    expect(toNodeIceServers([])).toEqual([]);
  });
});

describe("state / candidate normalizers", () => {
  it("passes through known connection states", () => {
    for (const s of [
      "new",
      "connecting",
      "connected",
      "disconnected",
      "failed",
      "closed",
    ] as const) {
      expect(normalizeConnectionState(s)).toBe(s);
      expect(normalizeConnectionState(s.toUpperCase())).toBe(s);
    }
  });

  it("treats an unknown connection state as failed (loud)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(normalizeConnectionState("weird")).toBe("failed");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("normalizes both SDP-short and libdatachannel-long candidate types", () => {
    expect(normalizeCandidateType("host")).toBe("host");
    expect(normalizeCandidateType("srflx")).toBe("srflx");
    expect(normalizeCandidateType("ServerReflexive")).toBe("srflx");
    expect(normalizeCandidateType("prflx")).toBe("prflx");
    expect(normalizeCandidateType("PeerReflexive")).toBe("prflx");
    expect(normalizeCandidateType("relay")).toBe("relay");
    expect(normalizeCandidateType("Relayed")).toBe("relay");
    expect(normalizeCandidateType("mystery")).toBeNull();
    expect(normalizeCandidateType(null)).toBeNull();
  });
});

describe("parseSdpFingerprint (remoteFingerprint SDP fallback)", () => {
  it("extracts and uppercases an a=fingerprint:sha-256 line", () => {
    const sdp = ["v=0", "a=fingerprint:sha-256 aa:bb:cc:dd", "a=setup:active"].join("\r\n");
    expect(parseSdpFingerprint(sdp)).toBe("AA:BB:CC:DD");
  });

  it("ignores non-sha-256 fingerprints and returns null when absent", () => {
    expect(parseSdpFingerprint("a=fingerprint:sha-1 aa:bb")).toBeNull();
    expect(parseSdpFingerprint("v=0\r\na=setup:active")).toBeNull();
  });
});

describe("candidateTypeFromPair — tolerant candidate-pair extraction", () => {
  it("reads either field name (type | candidateType) and normalizes any case", () => {
    expect(candidateTypeFromPair({ local: { type: "Host" } })).toBe("host");
    expect(candidateTypeFromPair({ local: { candidateType: "ServerReflexive" } })).toBe("srflx");
    expect(candidateTypeFromPair({ local: { type: "PeerReflexive" } })).toBe("prflx");
    expect(candidateTypeFromPair({ local: { candidateType: "Relayed" } })).toBe("relay");
    expect(candidateTypeFromPair({ local: { type: "relay" } })).toBe("relay");
  });

  it("prefers `type` over `candidateType` when both are present", () => {
    expect(candidateTypeFromPair({ local: { type: "host", candidateType: "relay" } })).toBe("host");
  });

  it("returns null for a missing/false/null pair or an unknown type (never throws)", () => {
    expect(candidateTypeFromPair(false)).toBeNull();
    expect(candidateTypeFromPair(null)).toBeNull();
    expect(candidateTypeFromPair(undefined)).toBeNull();
    expect(candidateTypeFromPair({})).toBeNull();
    expect(candidateTypeFromPair({ local: null })).toBeNull();
    expect(candidateTypeFromPair({ local: { type: "mystery" } })).toBeNull();
  });
});

describe("canonicalizeFingerprint — native fingerprint normalization", () => {
  it("uppercases colon-hex and strips a leading hash-name token", () => {
    expect(canonicalizeFingerprint("aa:bb:cc")).toBe("AA:BB:CC");
    expect(canonicalizeFingerprint("sha-256 aa:bb:cc")).toBe("AA:BB:CC");
    expect(canonicalizeFingerprint("  AA:BB  ")).toBe("AA:BB");
  });

  it("returns null when no colon-hex fingerprint is present (→ caller fails closed)", () => {
    expect(canonicalizeFingerprint("")).toBeNull();
    expect(canonicalizeFingerprint("not-a-fingerprint")).toBeNull();
    // Bare hex (no colons) is rejected so a stray algorithm token can't slip
    // through; the caller falls back to the SDP parse for the real value.
    expect(canonicalizeFingerprint("aabbcc")).toBeNull();
  });
});

// Build a WrappedPeerConnection over a structurally-complete fake native peer so
// the adapter methods (remoteFingerprint / selectedCandidateType / restartIce)
// are exercised WITHOUT the native binary — only the optional accessors under
// test are overridden per case.
type FakePc = Partial<ConstructorParameters<typeof WrappedPeerConnection>[0]>;
function wrap(overrides: FakePc = {}): WrappedPeerConnection {
  const noop = (): void => {};
  const base = {
    close: noop,
    setLocalDescription: noop,
    setRemoteDescription: noop,
    addRemoteCandidate: noop,
    createDataChannel: () => {
      throw new Error("createDataChannel not used in this test");
    },
    onLocalDescription: noop,
    onLocalCandidate: noop,
    onStateChange: noop,
    onDataChannel: noop,
    state: () => "new",
    ...overrides,
  };
  return new WrappedPeerConnection(
    base as unknown as ConstructorParameters<typeof WrappedPeerConnection>[0]
  );
}

describe("WrappedPeerConnection.remoteFingerprint — native + SDP fallback", () => {
  it("parses the remote SDP cached at setRemoteDescription when no native accessor exists", () => {
    const pc = wrap(); // neither remoteFingerprint() nor remoteDescription()
    const sdp = ["v=0", "a=setup:active", "a=fingerprint:sha-256 ab:CD:ef:01"].join("\r\n");
    void pc.setRemoteDescription({ type: "answer", sdp });
    expect(pc.remoteFingerprint()).toBe("AB:CD:EF:01");
  });

  it("is null before any remote description is set (fail-closed default)", () => {
    expect(wrap().remoteFingerprint()).toBeNull();
  });

  it("prefers the native accessor and canonicalizes its value (strips `sha-256 `)", () => {
    const pc = wrap({ remoteFingerprint: () => "sha-256 aa:bb:cc" });
    expect(pc.remoteFingerprint()).toBe("AA:BB:CC");
  });

  it("falls back to the SDP when the native accessor yields an unusable/empty value", () => {
    const pc = wrap({ remoteFingerprint: () => "" });
    void pc.setRemoteDescription({ type: "offer", sdp: "a=fingerprint:sha-256 11:22:33" });
    expect(pc.remoteFingerprint()).toBe("11:22:33");
  });

  it("tolerates a throwing native remoteFingerprint() and uses the SDP", () => {
    const pc = wrap({
      remoteFingerprint: () => {
        throw new Error("native blew up");
      },
    });
    void pc.setRemoteDescription({ type: "answer", sdp: "a=fingerprint:sha-256 de:ad:be:ef" });
    expect(pc.remoteFingerprint()).toBe("DE:AD:BE:EF");
  });

  it("reads a native remoteDescription() when nothing was cached", () => {
    const pc = wrap({
      remoteDescription: () => ({ sdp: "a=fingerprint:sha-256 0a:0b:0c", type: "answer" }),
    });
    expect(pc.remoteFingerprint()).toBe("0A:0B:0C");
  });
});

describe("WrappedPeerConnection.selectedCandidateType — getSelectedCandidatePair", () => {
  it("normalizes long/short, mixed-case types from either field name", () => {
    expect(
      wrap({
        getSelectedCandidatePair: () => ({ local: { type: "Host" } }),
      }).selectedCandidateType()
    ).toBe("host");
    expect(
      wrap({
        getSelectedCandidatePair: () => ({ local: { candidateType: "ServerReflexive" } }),
      }).selectedCandidateType()
    ).toBe("srflx");
    expect(
      wrap({
        getSelectedCandidatePair: () => ({ local: { type: "Relayed" } }),
      }).selectedCandidateType()
    ).toBe("relay");
  });

  it("is null when the pair is unavailable/false/null and never throws", () => {
    expect(wrap().selectedCandidateType()).toBeNull(); // no getSelectedCandidatePair at all
    expect(wrap({ getSelectedCandidatePair: () => false }).selectedCandidateType()).toBeNull();
    expect(wrap({ getSelectedCandidatePair: () => null }).selectedCandidateType()).toBeNull();
    expect(
      wrap({
        getSelectedCandidatePair: () => {
          throw new Error("not gathered yet");
        },
      }).selectedCandidateType()
    ).toBeNull();
  });
});

describe("WrappedPeerConnection.restartIce — coded-failure contract", () => {
  it("throws ICE_RESTART_UNSUPPORTED when the binding lacks a native restartIce()", () => {
    let caught: (Error & { code?: string }) | undefined;
    try {
      wrap().restartIce();
    } catch (error) {
      caught = error as Error & { code?: string };
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught?.code).toBe(ICE_RESTART_UNSUPPORTED_CODE);
    expect(ICE_RESTART_UNSUPPORTED_CODE).toBe("ICE_RESTART_UNSUPPORTED");
    expect(caught?.message).toMatch(/ICE restart is unsupported/);
  });

  it("delegates to the native restartIce() when present (no throw)", () => {
    const restart = vi.fn();
    const pc = wrap({ restartIce: restart });
    expect(() => pc.restartIce()).not.toThrow();
    expect(restart).toHaveBeenCalledTimes(1);
  });
});

describe("cert.ts — persistent ECDSA P-256 management", () => {
  it("generateSelfSignedEcCert mints a valid, self-verifying P-256 cert", () => {
    const { certPem, keyPem } = generateSelfSignedEcCert("unit-test");
    const cert = new X509Certificate(certPem);
    expect(cert.publicKey.asymmetricKeyType).toBe("ec");
    // A correct DER + ECDSA signature is the strongest proof the encoder is right.
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(cert.subject).toContain("unit-test");
    expect(keyPem).toMatch(/BEGIN PRIVATE KEY/);
  });

  it("two freshly minted certs have different fingerprints (MITM detectable, §11)", () => {
    const a = pemFingerprint(generateSelfSignedEcCert().certPem);
    const b = pemFingerprint(generateSelfSignedEcCert().certPem);
    expect(a).not.toBe(b);
  });

  it("ensurePersistentCert persists once and stays stable across reload", () => {
    const certFile = tmp("dtls-cert.pem");
    const keyFile = tmp("dtls-key.pem");
    const first = ensurePersistentCert({ certificatePemFile: certFile, keyPemFile: keyFile });
    expect(fs.existsSync(certFile)).toBe(true);
    expect(fs.existsSync(keyFile)).toBe(true);
    expect(first.fingerprint).toBe(certFileFingerprint(certFile));

    const before = fs.readFileSync(certFile, "utf8");
    const second = ensurePersistentCert({ certificatePemFile: certFile, keyPemFile: keyFile });
    // Reuse, not regenerate: identical bytes AND identical fingerprint.
    expect(fs.readFileSync(certFile, "utf8")).toBe(before);
    expect(second.fingerprint).toBe(first.fingerprint);
  });

  it("writes the private key with 0600 permissions", () => {
    if (process.platform === "win32") return; // POSIX mode bits are a no-op on Windows
    const certFile = tmp("c.pem");
    const keyFile = tmp("k.pem");
    ensurePersistentCert({ certificatePemFile: certFile, keyPemFile: keyFile });
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600);
  });
});
