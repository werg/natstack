import { describe, it, expect, vi, beforeEach } from "vitest";
import { doRefKey, doRefRpcUrl, DODispatch, type DORef } from "./doDispatch.js";

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

describe("doRefRpcUrl", () => {
  it("produces correct /_w/ URL path", () => {
    const ref = makeRef();
    expect(doRefRpcUrl(ref)).toBe(
      "/_w/workers/agent-worker/AiChatWorker/ch-123/__rpc"
    );
  });

  it("encodes special characters in className", () => {
    const ref = makeRef({ className: "My Worker" });
    const url = doRefRpcUrl(ref);
    expect(url).toBe("/_w/workers/agent-worker/My%20Worker/ch-123/__rpc");
    expect(url).toContain(encodeURIComponent("My Worker"));
  });

  it("encodes special characters in objectKey", () => {
    const ref = makeRef({ objectKey: "key/with:special chars" });
    const url = doRefRpcUrl(ref);
    expect(url).toBe(
      `/_w/workers/agent-worker/AiChatWorker/${encodeURIComponent("key/with:special chars")}/__rpc`
    );
  });

  it("does not encode the source path segments", () => {
    const ref = makeRef();
    const url = doRefRpcUrl(ref);
    // source "workers/agent-worker" should keep its slash
    expect(url.startsWith("/_w/workers/agent-worker/")).toBe(true);
  });
});

describe("DODispatch", () => {
  let dispatch: DODispatch;

  beforeEach(() => {
    vi.unstubAllGlobals();
    dispatch = new DODispatch();
  });

  describe("dispatch without dispatcher", () => {
    it("throws when no dispatcher has been configured", async () => {
      const ref = makeRef();
      await expect(dispatch.dispatch(ref, "ping")).rejects.toThrow(
        "DODispatch: no dispatcher configured"
      );
    });
  });

  describe("dispatch with dispatcher", () => {
    it("calls the dispatcher with the correct RPC URL path and envelope", async () => {
      const dispatcher = vi.fn().mockResolvedValue({ ok: true });
      dispatch.setDispatcher(dispatcher);

      const ref = makeRef();
      await dispatch.dispatch(ref, "ping", "arg1", 42);

      expect(dispatcher).toHaveBeenCalledTimes(1);
      expect(dispatcher).toHaveBeenCalledWith(
        "/_w/workers/agent-worker/AiChatWorker/ch-123/__rpc",
        { type: "call", method: "ping", args: ["arg1", 42], sourceId: "main" }
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

      expect(dispatcher).toHaveBeenCalledWith(expect.any(String), {
        type: "call",
        method: "noArgs",
        args: [],
        sourceId: "main",
      });
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

  describe("dispatch with workerd URL", () => {
    it("retries fetch failures after ensuring the DO and refreshes the workerd URL", async () => {
      const ensureDO = vi.fn().mockResolvedValue(undefined);
      const getWorkerdUrl = vi
        .fn()
        .mockReturnValueOnce("http://127.0.0.1:10001")
        .mockReturnValueOnce("http://127.0.0.1:10002");
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ result: { ok: true } }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );

      vi.stubGlobal("fetch", fetchMock);
      dispatch.setGetWorkerdUrl(getWorkerdUrl);
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setEnsureDO(ensureDO);

      const ref = makeRef();
      await expect(dispatch.dispatch(ref, "ping", "arg")).resolves.toEqual({ ok: true });

      expect(ensureDO).toHaveBeenCalledWith(ref.source, ref.className, ref.objectKey);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        "http://127.0.0.1:10001/_w/workers/agent-worker/AiChatWorker/ch-123/__rpc",
        expect.any(Object)
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        "http://127.0.0.1:10002/_w/workers/agent-worker/AiChatWorker/ch-123/__rpc",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer workerd-gateway-token",
          }),
        })
      );
    });
  });
});
