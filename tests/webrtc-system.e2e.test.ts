/**
 * COMPLETE WebRTC system end-to-end — the whole pipe, locally, with Cloudflare's
 * local runtime for signaling:
 *
 *   `wrangler dev apps/signaling`  (real SignalingRoom Durable Object, Miniflare)
 *        ▲                                          ▲
 *   createSignalingClient (offerer)         createSignalingClient (answerer)
 *        │            real node-datachannel DTLS            │
 *   createWebRtcTransport  ⇄═══════════════════════⇄  createWebRtcAnswererPipe
 *        │  (CLI-style client)                             │
 *   openSession(shell token)                    RpcServer.attachWebRtcPipe
 *        │                                                 │
 *        └──────────── real RPC round-trip ────────────────┘
 *
 * This boots the actual signaling Worker via `wrangler dev` (Cloudflare's local
 * deployment system), runs the REAL `RpcServer` as the WebRTC answerer, and a
 * CLI-shaped offerer client, then asserts an RPC dispatch and a bulk stream flow
 * the whole way. Two adapter bugs (the {value,algorithm} fingerprint, channel-vs-
 * ICE open timing) were first caught here against the live native module.
 *
 * Gated behind NATSTACK_RUN_WEBRTC_E2E=1 (spawns wrangler dev + opens real UDP):
 *   NATSTACK_RUN_WEBRTC_E2E=1 npx vitest run tests/webrtc-system.e2e.test.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CallerKind, ServiceContext, ServiceDispatcher } from "@natstack/shared/serviceDispatcher";
import { TokenManager } from "@natstack/shared/tokenManager";
import { EntityCache } from "@natstack/shared/runtime/entityCache";
import type { RpcEnvelope } from "@natstack/rpc";
import { createWebRtcTransport } from "@natstack/rpc/transports/webrtcClient";
import { createWebRtcAnswererPipe } from "@natstack/rpc/transports/webrtcAnswerer";
import { createSignalingClient } from "@natstack/rpc/transports/webrtcSignalingClient";
import { RpcServer } from "../src/server/rpcServer.js";
import { DeviceAuthStore } from "../src/server/services/deviceAuthStore.js";
import { createPairingRedeemer } from "../src/server/services/authService.js";
import { createNodeDatachannelProvider } from "../src/main/webrtc/nodeDatachannelPeer.js";
import { ensurePersistentCert } from "../src/main/webrtc/cert.js";

const RUN = process.env["NATSTACK_RUN_WEBRTC_E2E"] === "1";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SIGNAL_PORT = 8798;
const SIG = `ws://127.0.0.1:${SIGNAL_PORT}`;
const WS = WebSocket as unknown as new (url: string) => WebSocket;

let wrangler: ChildProcess | null = null;

async function startSignaling(): Promise<void> {
  wrangler = spawn(
    path.join(repoRoot, "node_modules/.bin/wrangler"),
    ["dev", "--port", String(SIGNAL_PORT), "--local", "--var", "ENVIRONMENT:test"],
    { cwd: path.join(repoRoot, "apps/signaling"), stdio: "ignore" },
  );
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${SIGNAL_PORT}/healthz`);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("wrangler dev (signaling) did not become healthy");
}

/** Minimal real RpcServer whose dispatcher echoes the call (proves the dispatch path). */
function makeServer(authStorePath: string): {
  server: RpcServer;
  tokenManager: TokenManager;
  deviceAuthStore: DeviceAuthStore;
  dispatched: Array<{ service: string; method: string; args: unknown[] }>;
} {
  const tokenManager = new TokenManager();
  const dispatched: Array<{ service: string; method: string; args: unknown[] }> = [];
  const dispatcher = {
    initialized: true,
    dispatch: async (_ctx: ServiceContext, service: string, method: string, args: unknown[]) => {
      dispatched.push({ service, method, args });
      return { ok: true, echo: { service, method, args } };
    },
    getPolicy: (service: string) =>
      service === "demo" ? { allowed: ["shell", "panel", "worker", "server"] as CallerKind[] } : undefined,
    getMethodPolicy: () => undefined,
  } as unknown as ServiceDispatcher;
  // Real device-auth store + the over-the-pipe pairing redeemer, so a fresh
  // device can present a QR code (and a returning one a refresh credential).
  const deviceAuthStore = new DeviceAuthStore(authStorePath);
  const server = new RpcServer({
    tokenManager,
    dispatcher,
    entityCache: new EntityCache(),
    redeemPairingCredential: createPairingRedeemer({ deviceAuthStore, tokenManager }),
  });
  return { server, tokenManager, deviceAuthStore, dispatched };
}

interface System {
  client: ReturnType<typeof createWebRtcTransport>;
  pipe: ReturnType<typeof createWebRtcAnswererPipe>;
  shutdown: () => Promise<void>;
}

async function bringUp(room: string, certFingerprint: string, certFile: string, keyFile: string, server: RpcServer): Promise<System> {
  // --- server side: answerer over the real signaling DO ---
  const serverSig = createSignalingClient({ room, sig: SIG, WebSocketImpl: WS, fetchImpl: fetch });
  const pipe = createWebRtcAnswererPipe({
    provider: createNodeDatachannelProvider({ peerName: "server" }),
    signaling: serverSig,
    pairing: { iceServers: [], certificatePemFile: certFile, keyPemFile: keyFile },
  });
  server.attachWebRtcPipe(pipe);
  const answering = pipe.connect(); // joins the room, awaits the offer

  // --- client side: CLI-style offerer, pinning the server's fingerprint ---
  await new Promise((r) => setTimeout(r, 300)); // let the answerer join the room first
  const client = createWebRtcTransport({
    provider: createNodeDatachannelProvider({ peerName: "client" }),
    createSignaling: () => createSignalingClient({ room, sig: SIG, WebSocketImpl: WS, fetchImpl: fetch }),
    pairing: { room, fingerprint: certFingerprint, sig: SIG, iceServers: [] },
    role: "offerer",
  });
  const connecting = client.connect();
  await Promise.all([answering, connecting]);

  return {
    client,
    pipe,
    shutdown: async () => {
      await client.close();
      await pipe.close();
    },
  };
}

describe.runIf(RUN)("WebRTC complete system e2e (wrangler-dev signaling + real DTLS + real RpcServer)", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-rtc-sys-"));
  const cert = ensurePersistentCert({ certificatePemFile: path.join(tmp, "server.pem"), keyPemFile: path.join(tmp, "server.key") });
  let sys: System | null = null;
  let shellToken = "";
  let deviceAuthStore: DeviceAuthStore;
  let dispatched: Array<{ service: string; method: string; args: unknown[] }> = [];

  beforeAll(async () => {
    await startSignaling();
    const s = makeServer(path.join(tmp, "auth", "devices.json"));
    dispatched = s.dispatched;
    deviceAuthStore = s.deviceAuthStore;
    shellToken = s.tokenManager.ensureToken("shell:cli-e2e", "shell");
    sys = await bringUp(randomUUID(), cert.fingerprint, cert.certificatePemFile, cert.keyPemFile, s.server);
  }, 120_000);

  afterAll(async () => {
    await sys?.shutdown().catch(() => {});
    wrangler?.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("connects the pipe through the live signaling DO and pins the server cert", () => {
    expect(sys!.client.status()).toBe("connected");
  });

  it("opens a shell session (real handleAuth over the pipe) and round-trips an RPC dispatch", async () => {
    const session = sys!.client.openSession({ connectionId: "cli-conn-1", callerKind: "shell", getToken: () => shellToken });
    await session.ready!();
    expect(session.callerId()).toBe("shell:cli-e2e");

    const received: RpcEnvelope[] = [];
    session.onMessage((e) => received.push(e));
    await session.send({
      from: "shell:cli-e2e",
      target: "main",
      delivery: { caller: { callerId: "shell:cli-e2e", callerKind: "shell" } },
      provenance: [{ callerId: "shell:cli-e2e", callerKind: "shell" }],
      message: { type: "request", requestId: "sys-1", fromId: "shell:cli-e2e", method: "demo.hello", args: ["world"] },
    });
    await waitFor(() => received.length > 0);
    const result = received[0]!.message as { result?: { ok: boolean; echo: { method: string; args: unknown[] } } };
    expect(result.result?.ok).toBe(true);
    expect(result.result?.echo).toEqual({ service: "demo", method: "hello", args: ["world"] });
    // The REAL server dispatcher was invoked.
    expect(dispatched.some((d) => d.service === "demo" && d.method === "hello")).toBe(true);
  }, 30_000);

  it("pairs a fresh device over the pipe (QR code → device credential) then reconnects with the refresh credential", async () => {
    // A fresh device presents the one-time QR pairing code as its session token.
    const code = deviceAuthStore.createPairingCode(60_000);
    let paired: { deviceId: string; refreshToken: string } | null = null;
    const pairing = sys!.client.openSession({
      connectionId: "pair-conn-1",
      callerKind: "shell",
      clientLabel: "e2e-laptop",
      getToken: () => code,
      onPaired: (cred) => {
        paired = cred;
      },
    });
    await pairing.ready!();
    // The server redeemed the code → issued a device credential (delivered back on
    // the auth-result) and bound the session to the device's shell principal.
    expect(paired).not.toBeNull();
    expect(paired!.deviceId).toMatch(/^dev_/);
    expect(paired!.refreshToken.length).toBeGreaterThan(16);
    expect(pairing.callerId()).toBe(`shell:${paired!.deviceId}`);
    pairing.close();

    // The same code is one-shot — a second redemption is rejected (terminal auth fail).
    const replay = sys!.client.openSession({ connectionId: "pair-replay", callerKind: "shell", getToken: () => code });
    await expect(replay.ready!()).rejects.toThrow();

    // The returning device authenticates with `refresh:<deviceId>:<refreshToken>`
    // — no re-pairing, and no new credential is issued.
    let secondCred: unknown = null;
    const reconnect = sys!.client.openSession({
      connectionId: "pair-conn-2",
      callerKind: "shell",
      getToken: () => `refresh:${paired!.deviceId}:${paired!.refreshToken}`,
      onPaired: (cred) => {
        secondCred = cred;
      },
    });
    await reconnect.ready!();
    expect(reconnect.callerId()).toBe(`shell:${paired!.deviceId}`);
    expect(secondCred).toBeNull();
    reconnect.close();
  }, 30_000);
});

async function waitFor(pred: () => boolean, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
