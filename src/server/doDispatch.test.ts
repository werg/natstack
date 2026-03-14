import { describe, it, expect, vi, beforeEach } from "vitest";
import { doRefKey, doRefUrl, DODispatch, type DORef } from "./doDispatch.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRef(overrides: Partial<DORef> = {}): DORef {
  return {
    source: "workers/agent-worker",
    className: "AiChatWorker",
    objectKey: "ch-123",
    ...overrides,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("doRefKey", () => {
  it("produces the canonical source:className/objectKey string", () => {
    const ref = makeRef();
    expect(doRefKey(ref)).toBe("workers/agent-worker:AiChatWorker/ch-123");
  });

  it("preserves slashes in source path", () => {
    const ref = makeRef({ source: "workspace/workers/deep" });
    expect(doRefKey(ref)).toBe("workspace/workers/deep:AiChatWorker/ch-123");
  });
});

describe("doRefUrl", () => {
  it("produces correct /_w/ URL path", () => {
    const ref = makeRef();
    expect(doRefUrl(ref, "onChannelEvent")).toBe(
      "/_w/workers/agent-worker/AiChatWorker/ch-123/onChannelEvent",
    );
  });

  it("encodes special characters in className", () => {
    const ref = makeRef({ className: "My Worker" });
    const url = doRefUrl(ref, "doSomething");
    expect(url).toBe("/_w/workers/agent-worker/My%20Worker/ch-123/doSomething");
    expect(url).toContain(encodeURIComponent("My Worker"));
  });

  it("encodes special characters in objectKey", () => {
    const ref = makeRef({ objectKey: "key/with:special chars" });
    const url = doRefUrl(ref, "method");
    expect(url).toBe(
      `/_w/workers/agent-worker/AiChatWorker/${encodeURIComponent("key/with:special chars")}/method`,
    );
  });

  it("encodes the method name", () => {
    const ref = makeRef();
    const url = doRefUrl(ref, "some method");
    expect(url).toContain(encodeURIComponent("some method"));
  });

  it("does not encode the source path segments", () => {
    const ref = makeRef();
    const url = doRefUrl(ref, "ping");
    // source "workers/agent-worker" should keep its slash
    expect(url.startsWith("/_w/workers/agent-worker/")).toBe(true);
  });
});

describe("DODispatch", () => {
  let dispatch: DODispatch;

  beforeEach(() => {
    dispatch = new DODispatch();
  });

  describe("dispatch without dispatcher", () => {
    it("throws when no dispatcher has been configured", async () => {
      const ref = makeRef();
      await expect(dispatch.dispatch(ref, "ping")).rejects.toThrow(
        "DODispatch: no dispatcher configured",
      );
    });
  });

  describe("dispatch with dispatcher", () => {
    it("calls the dispatcher with the correct URL path and args", async () => {
      const dispatcher = vi.fn().mockResolvedValue({ ok: true });
      dispatch.setDispatcher(dispatcher);

      const ref = makeRef();
      await dispatch.dispatch(ref, "onChannelEvent", "arg1", 42);

      expect(dispatcher).toHaveBeenCalledTimes(1);
      expect(dispatcher).toHaveBeenCalledWith(
        "/_w/workers/agent-worker/AiChatWorker/ch-123/onChannelEvent",
        ["arg1", 42],
      );
    });

    it("returns whatever the dispatcher returns", async () => {
      const expected = { result: "hello", count: 7 };
      const dispatcher = vi.fn().mockResolvedValue(expected);
      dispatch.setDispatcher(dispatcher);

      const ref = makeRef();
      const result = await dispatch.dispatch(ref, "getData");

      expect(result).toBe(expected);
    });

    it("propagates errors from the dispatcher", async () => {
      const dispatcher = vi.fn().mockRejectedValue(new Error("network failure"));
      dispatch.setDispatcher(dispatcher);

      const ref = makeRef();
      await expect(dispatch.dispatch(ref, "fail")).rejects.toThrow("network failure");
    });

    it("passes empty args array when no extra args given", async () => {
      const dispatcher = vi.fn().mockResolvedValue(undefined);
      dispatch.setDispatcher(dispatcher);

      const ref = makeRef();
      await dispatch.dispatch(ref, "noArgs");

      expect(dispatcher).toHaveBeenCalledWith(
        expect.any(String),
        [],
      );
    });

    it("replaces the dispatcher when setDispatcher is called again", async () => {
      const first = vi.fn().mockResolvedValue("first");
      const second = vi.fn().mockResolvedValue("second");
      dispatch.setDispatcher(first);
      dispatch.setDispatcher(second);

      const ref = makeRef();
      const result = await dispatch.dispatch(ref, "test");

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledTimes(1);
      expect(result).toBe("second");
    });
  });
});
