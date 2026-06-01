import {
  authenticatedCaller,
  envelopeFromMessage,
  originOfEnvelope,
  responseEnvelopeFor,
  retargetEnvelope,
} from "./envelope.js";

describe("envelope helpers", () => {
  it("creates an envelope with caller provenance when none is provided", () => {
    const envelope = envelopeFromMessage({
      selfId: "a",
      from: "panel:1",
      target: "worker:1",
      callerKind: "panel",
      message: { type: "event", fromId: "panel:1", event: "ready", payload: null },
    });

    expect(envelope.delivery.caller).toEqual({ callerId: "panel:1", callerKind: "panel" });
    expect(envelope.provenance).toEqual([{ callerId: "panel:1", callerKind: "panel" }]);
    expect(originOfEnvelope(envelope)).toEqual({ callerId: "panel:1", callerKind: "panel" });
  });

  it("preserves forwarded provenance and idempotency keys", () => {
    const origin = authenticatedCaller("panel:1", "panel");
    const envelope = envelopeFromMessage({
      selfId: "worker:1",
      from: "worker:1",
      target: "do:store:Bucket:key",
      callerKind: "worker",
      provenance: [origin, authenticatedCaller("worker:1", "worker")],
      idempotencyKey: "idem-1",
      message: { type: "request", requestId: "r1", fromId: "worker:1", method: "save", args: [] },
    });

    expect(envelope.provenance[0]).toBe(origin);
    expect(envelope.delivery.idempotencyKey).toBe("idem-1");
    expect(originOfEnvelope(envelope)).toBe(origin);
  });

  it("retargets and creates response envelopes without changing provenance", () => {
    const request = envelopeFromMessage({
      selfId: "panel:1",
      from: "panel:1",
      target: "worker:1",
      callerKind: "panel",
      message: { type: "request", requestId: "r1", fromId: "panel:1", method: "ping", args: [] },
    });

    expect(retargetEnvelope(request, "worker:2").target).toBe("worker:2");
    const response = responseEnvelopeFor(
      request,
      authenticatedCaller("worker:1", "worker"),
      { type: "response", requestId: "r1", result: "pong" },
    );

    expect(response.from).toBe("worker:1");
    expect(response.target).toBe("panel:1");
    expect(response.provenance).toBe(request.provenance);
  });
});
