import { describe, expect, it } from "vitest";
import { StreamFrameDecoderV2 } from "@natstack/rpc/protocol/streamCodec";
import {
  decodeControlFrame,
  type SessionControlFrame,
} from "@natstack/rpc/protocol/sessionNegotiation";
import type { WsClientMessage, WsServerMessage } from "@natstack/shared/ws/protocol";
import { SessionWebSocketShim, type PipeChannels } from "./webrtcSessionShim.js";

function harness() {
  const control: SessionControlFrame[] = [];
  const bulk: Array<{ streamId: number; type: number; payload: Uint8Array }> = [];
  const bulkDecoder = new StreamFrameDecoderV2((streamId, type, payload) => {
    bulk.push({ streamId, type, payload });
  });
  const pipe: PipeChannels = {
    writeControl: (d) => {
      control.push(decodeControlFrame(new TextDecoder().decode(d)));
    },
    writeBulk: (d) => void bulkDecoder.push(d),
    controlBufferedAmount: () => 0,
  };
  const closedSids: string[] = [];
  const shim = new SessionWebSocketShim("s1", pipe, (sid) => closedSids.push(sid));
  return { shim, control, bulk, closedSids };
}

describe("SessionWebSocketShim — ws:* <-> session-frame translation", () => {
  it("delivers an inbound ws:auth to the message handler as a Buffer", () => {
    const h = harness();
    const got: string[] = [];
    h.shim.on("message", (data) => got.push((data as Buffer).toString()));
    const auth: WsClientMessage = { type: "ws:auth", token: "grant", connectionId: "c1" };
    h.shim.deliverInbound(auth);
    expect(JSON.parse(got[0]!)).toMatchObject({
      type: "ws:auth",
      token: "grant",
      connectionId: "c1",
    });
  });

  it("translates a successful ws:auth-result into an open-result control frame", () => {
    const h = harness();
    const result: WsServerMessage = {
      type: "ws:auth-result",
      success: true,
      callerId: "panel:c1",
      callerKind: "panel",
      connectionId: "c1",
      serverBootId: "boot-1",
      sessionDirty: false,
    };
    h.shim.send(JSON.stringify(result));
    expect(h.control[0]).toMatchObject({
      t: "open-result",
      sid: "s1",
      success: true,
      callerId: "panel:c1",
      serverBootId: "boot-1",
    });
  });

  it("marks a failed ws:auth-result terminal (no client auto-reopen)", () => {
    const h = harness();
    h.shim.send(
      JSON.stringify({
        type: "ws:auth-result",
        success: false,
        error: "Panel runtime is leased by Desktop",
      } satisfies WsServerMessage)
    );
    expect(h.control[0]).toMatchObject({
      t: "open-result",
      success: false,
      terminal: true,
      error: /leased/ as unknown as string,
    });
  });

  it("translates ws:routed / ws:event / routed-response-error frames", () => {
    const h = harness();
    const env = {
      from: "main",
      target: "panel:c1",
      delivery: { caller: { callerId: "main", callerKind: "server" as const } },
      provenance: [],
      message: { type: "response" as const, requestId: "r1", result: 1 },
    };
    h.shim.send(JSON.stringify({ type: "ws:routed", envelope: env } satisfies WsServerMessage));
    h.shim.send(
      JSON.stringify({ type: "ws:event", event: "x", payload: 7 } satisfies WsServerMessage)
    );
    h.shim.send(
      JSON.stringify({
        type: "ws:routed-response-error",
        targetId: "do:x",
        requestId: "r2",
        error: "gone",
        errorCode: "TARGET_NOT_REACHABLE",
      } satisfies WsServerMessage)
    );
    expect(h.control.map((f) => f.t)).toEqual(["routed", "event", "routed-response-error"]);
  });

  it("re-encodes a server stream-frame (base64 DATA) onto the binary bulk channel by streamId", () => {
    const h = harness();
    // The client allocated streamId 77 for requestId 'req-1' in its stream-open.
    h.shim.registerStream("req-1", 77);
    const dataB64 = Buffer.from("hello-bulk").toString("base64");
    const streamFrameEnvelope = {
      from: "main",
      target: "panel:c1",
      delivery: { caller: { callerId: "main", callerKind: "server" as const } },
      provenance: [],
      message: {
        type: "stream-frame" as const,
        requestId: "req-1",
        fromId: "main",
        frameType: 0x02,
        payload: dataB64,
      },
    };
    h.shim.send(
      JSON.stringify({ type: "ws:rpc", envelope: streamFrameEnvelope } as WsServerMessage)
    );
    expect(h.bulk).toHaveLength(1);
    expect(h.bulk[0]!.streamId).toBe(77);
    expect(h.bulk[0]!.type).toBe(0x02);
    expect(new TextDecoder().decode(h.bulk[0]!.payload)).toBe("hello-bulk");
    // Control channel got nothing (streaming rides bulk, not control).
    expect(h.control).toHaveLength(0);
  });

  it("reaps the (per-shim) stream mapping on an END frame — a later frame is dropped", () => {
    const h = harness();
    h.shim.registerStream("req-1", 77);
    const streamFrame = (frameType: number, payload: string): WsServerMessage =>
      ({
        type: "ws:rpc",
        envelope: {
          from: "main",
          target: "panel:c1",
          delivery: { caller: { callerId: "main", callerKind: "server" as const } },
          provenance: [],
          message: {
            type: "stream-frame" as const,
            requestId: "req-1",
            fromId: "main",
            frameType,
            payload,
          },
        },
      }) as WsServerMessage;
    // END writes its frame AND reaps the mapping.
    h.shim.send(JSON.stringify(streamFrame(0x03, JSON.stringify({ bytesIn: 10 }))));
    expect(h.bulk).toHaveLength(1);
    // A DATA frame for the same request after END finds no streamId → dropped
    // (the per-shim maps are reaped, so nothing leaks past END).
    h.shim.send(JSON.stringify(streamFrame(0x02, Buffer.from("late").toString("base64"))));
    expect(h.bulk).toHaveLength(1);
  });

  it("cancelStream() reaps the mapping and delivers a stream-cancel inward", () => {
    const h = harness();
    const inbound: WsClientMessage[] = [];
    h.shim.on("message", (data) => inbound.push(JSON.parse((data as Buffer).toString())));
    h.shim.registerStream("req-1", 77);
    h.shim.cancelStream(77);
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      type: "ws:rpc",
      envelope: { message: { type: "stream-cancel", requestId: "req-1" } },
    });
    // Cancelling again is a no-op (mapping already reaped).
    h.shim.cancelStream(77);
    expect(inbound).toHaveLength(1);
  });

  it("a non-streaming ws:rpc bridge call becomes an rpc control frame", () => {
    const h = harness();
    const env = {
      from: "main",
      target: "panel:c1",
      delivery: { caller: { callerId: "main", callerKind: "server" as const } },
      provenance: [],
      message: {
        type: "request" as const,
        requestId: "bridge-1",
        fromId: "main",
        method: "panel.ping",
        args: [],
      },
    };
    h.shim.send(JSON.stringify({ type: "ws:rpc", envelope: env } as WsServerMessage));
    expect(h.control[0]).toMatchObject({ t: "rpc", sid: "s1" });
  });

  it("close() writes a terminal closed-frame for lease-revoke codes and fires close handlers", () => {
    const h = harness();
    const closeArgs: unknown[][] = [];
    h.shim.on("close", (...args) => closeArgs.push(args));
    h.shim.close(4091, "lease revoked");
    expect(h.control[0]).toMatchObject({ t: "closed", sid: "s1", code: 4091, terminal: true });
    expect(closeArgs[0]![0]).toBe(4091);
    expect(h.closedSids).toEqual(["s1"]);
    // After close, the shim is no longer OPEN and drops further sends.
    expect(h.shim.readyState).toBe(3);
    h.shim.send(
      JSON.stringify({ type: "ws:event", event: "late", payload: 1 } satisfies WsServerMessage)
    );
    expect(h.control).toHaveLength(1);
  });

  it("remoteClosed() (client/pipe drop) fires close handlers without writing a frame", () => {
    const h = harness();
    const fired: unknown[][] = [];
    h.shim.on("close", (...a) => fired.push(a));
    h.shim.remoteClosed(1006, "pipe lost");
    expect(fired).toHaveLength(1);
    expect(h.control).toHaveLength(0); // no outbound frame — the client already knows
    expect(h.closedSids).toEqual(["s1"]);
  });

  it("off() removes the onFirstMessage-style handler (matches rpcServer's ws.off)", () => {
    const h = harness();
    const got: number[] = [];
    const handler = (): void => void got.push(1);
    h.shim.on("message", handler);
    h.shim.off("message", handler);
    h.shim.deliverInbound({ type: "ws:auth", token: "t" });
    expect(got).toHaveLength(0);
  });
});
