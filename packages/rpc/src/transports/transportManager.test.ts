import { describe, expect, it } from "vitest";
import type { RpcConnectionStatus, RpcEnvelope } from "../types.js";
import type { RecoveryKind } from "../protocol/recoveryCoordinator.js";
import { createTransportManager, type ManagedTransport } from "./transportManager.js";

function fakeManaged(): ManagedTransport & {
  emitRecovery(kind: RecoveryKind): void;
  sent: RpcEnvelope[];
} {
  const recoveryHandlers: Record<RecoveryKind, Array<() => void | Promise<void>>> = {
    resubscribe: [],
    "cold-recover": [],
  };
  const sent: RpcEnvelope[] = [];
  let status: RpcConnectionStatus = "disconnected";
  return {
    sent,
    async send(e) {
      sent.push(e);
    },
    onMessage() {
      return () => {};
    },
    status: () => status,
    ready: async () => {
      status = "connected";
    },
    onStatusChange: () => () => {},
    onRecovery(kind, handler) {
      recoveryHandlers[kind].push(handler);
      return () => {};
    },
    async connect() {
      status = "connected";
    },
    close() {},
    emitRecovery(kind) {
      for (const h of recoveryHandlers[kind]) void h();
    },
  };
}

describe("TransportManager", () => {
  it("passes send/status/ready through to the single transport", async () => {
    const inner = fakeManaged();
    const mgr = createTransportManager({ transport: inner });
    await mgr.connect();
    expect(mgr.status()).toBe("connected");
    const env = { from: "a", target: "main", delivery: { caller: { callerId: "a", callerKind: "panel" as const } }, provenance: [], message: { type: "event" as const, event: "x", payload: 1, fromId: "a" } };
    await mgr.send(env);
    expect(inner.sent).toHaveLength(1);
  });

  it("drives the recovery coordinator from the transport's recovery signal", async () => {
    const inner = fakeManaged();
    const mgr = createTransportManager({ transport: inner });
    const fired: string[] = [];
    mgr.recovery.registerResubscribeHandler("sub", async () => {
      fired.push("resub");
    });
    mgr.recovery.registerColdRecoverHandler("cold", async () => {
      fired.push("cold");
    });
    inner.emitRecovery("cold-recover");
    await new Promise((r) => setTimeout(r, 5));
    expect(fired).toContain("cold");
  });

  it("exposes the underlying transport as an escape hatch (e.g. WebRTC openSession)", () => {
    const inner = fakeManaged();
    const mgr = createTransportManager({ transport: inner });
    expect(mgr.transport).toBe(inner);
  });
});
