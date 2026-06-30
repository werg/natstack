import { describe, it, expect, vi } from "vitest";
import type { RpcEnvelope } from "@natstack/rpc";
import type { WebRtcSession, WebRtcTransport } from "@natstack/rpc/transports/webrtcClient";
import type { ConnectPairing } from "@natstack/shared/connect";
import { createWebRtcServerClient } from "./webrtcServerClient.js";

const PAIRING = {
  room: "room-1",
  fp: "AA:BB:CC",
  code: "code-1",
  sig: "ws://127.0.0.1:8787",
  ice: "all",
} as ConnectPairing;

type RpcHandler = (target: string, method: string, args: unknown[]) => unknown;

/**
 * A fake WebRtcTransport whose sessions echo RPC requests back through a handler.
 * Each openSession() answers its own send()s, so the main shell session and the
 * scoped app session are independent — exactly the production topology.
 */
function makeFakeTransport(handler: RpcHandler) {
  const opened: Array<{ opts: { callerKind?: string }; session: WebRtcSession }> = [];
  let status: "connected" | "disconnected" = "disconnected";
  const transport = {
    connect: vi.fn(async () => {
      status = "connected";
    }),
    ready: async () => {},
    status: () => status,
    onStatusChange: () => () => {},
    candidateType: () => null,
    close: vi.fn(async () => {
      status = "disconnected";
    }),
    openSession: (opts: {
      sid?: string;
      connectionId?: string;
      callerKind?: string;
      getToken?: () => string | Promise<string>;
    }): WebRtcSession => {
      const listeners = new Set<(e: RpcEnvelope) => void>();
      // Mirror the real openSession: it invokes getToken to redeem the (one-shot)
      // connection grant during the handshake that ready() awaits.
      const authReady = Promise.resolve(opts.getToken?.());
      let closed = false;
      const session = {
        sid: opts.sid ?? opts.connectionId ?? "sid",
        callerId: () => "main",
        ready: async () => {
          await authReady;
        },
        isClosed: () => closed,
        close: vi.fn(() => {
          closed = true;
        }),
        send: async (env: RpcEnvelope) => {
          const message = env.message as {
            type: string;
            requestId: string;
            method: string;
            args: unknown[];
          };
          if (message.type !== "request") return;
          const result = await handler(env.target, message.method, message.args);
          const response: RpcEnvelope = {
            from: "main",
            target: env.from,
            delivery: { caller: { callerId: "main", callerKind: "server" } },
            provenance: [{ callerId: "main", callerKind: "server" }],
            message: { type: "response", requestId: message.requestId, result } as never,
          };
          queueMicrotask(() => {
            for (const listener of listeners) listener(response);
          });
        },
        onMessage: (cb: (e: RpcEnvelope) => void) => {
          listeners.add(cb);
          return () => listeners.delete(cb);
        },
      } as unknown as WebRtcSession;
      opened.push({ opts, session });
      return session;
    },
  } as unknown as WebRtcTransport;
  return { transport, opened };
}

describe("createWebRtcServerClient", () => {
  it("builds a connected ServerClient that round-trips call() over a shell session", async () => {
    const { transport, opened } = makeFakeTransport((target, method, args) =>
      target === "main" && method === "demo.echo" ? { echoed: args[0] } : null
    );
    const client = await createWebRtcServerClient({
      pairing: PAIRING,
      callerId: "shell:dev",
      getShellToken: () => "shell-token",
      transport,
    });
    expect(transport.connect).toHaveBeenCalledOnce();
    expect(opened[0]!.opts.callerKind).toBe("shell");
    expect(client.isConnected()).toBe(true);
    expect(client.getConnectionStatus()).toBe("connected");
    await expect(client.call("demo", "echo", ["hi"])).resolves.toEqual({ echoed: "hi" });
  });

  it("opens a scoped app session via a one-time connection grant for callAs()", async () => {
    let grants = 0;
    const { transport, opened } = makeFakeTransport((_target, method) => {
      if (method === "auth.grantConnection") {
        grants += 1;
        return { token: "grant-tok" };
      }
      if (method === "svc.ping") return { pong: true };
      return null;
    });
    const client = await createWebRtcServerClient({
      pairing: PAIRING,
      callerId: "shell:dev",
      getShellToken: () => "t",
      transport,
    });
    await expect(
      client.callAs({ callerId: "app:1", callerKind: "app" }, "svc", "ping", [])
    ).resolves.toEqual({ pong: true });
    expect(grants).toBe(1);
    // main shell session + one scoped app session over the same pipe
    expect(opened.map((o) => o.opts.callerKind)).toEqual(["shell", "app"]);

    // Grants are one-shot: if the scoped session dies (lease revoke / pipe drop),
    // the next callAs must RE-GRANT a fresh token, not reuse the consumed one
    // (the bug that left a listen-only app principal dead after any reconnect).
    opened.find((o) => o.opts.callerKind === "app")!.session.close();
    await expect(
      client.callAs({ callerId: "app:1", callerKind: "app" }, "svc", "ping", [])
    ).resolves.toEqual({ pong: true });
    expect(grants).toBe(2);
    expect(opened.map((o) => o.opts.callerKind)).toEqual(["shell", "app", "app"]);
  });

  it("rejects scoped server RPC for non-app callers", async () => {
    const { transport } = makeFakeTransport(() => null);
    const client = await createWebRtcServerClient({
      pairing: PAIRING,
      callerId: "shell:dev",
      getShellToken: () => "t",
      transport,
    });
    await expect(
      client.callAs({ callerId: "x", callerKind: "shell" }, "s", "m", [])
    ).rejects.toThrow(/not available/);
  });

  it("close() tears down scoped sessions, the main session, and the transport", async () => {
    const { transport, opened } = makeFakeTransport((_target, method) =>
      method === "auth.grantConnection" ? { token: "g" } : { ok: true }
    );
    const client = await createWebRtcServerClient({
      pairing: PAIRING,
      callerId: "shell:dev",
      getShellToken: () => "t",
      transport,
    });
    await client.callAs({ callerId: "app:1", callerKind: "app" }, "svc", "ping", []);
    await client.close();
    expect(transport.close).toHaveBeenCalledOnce();
    for (const { session } of opened) {
      expect(session.close as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalled();
    }
  });
});
