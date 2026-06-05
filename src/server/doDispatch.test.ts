import { describe, it, expect, vi, beforeEach } from "vitest";
import { TokenManager } from "@natstack/shared/tokenManager";
import { doRefKey, doRefUrl, encodeUniversalKey, DODispatch, type DORef } from "./doDispatch.js";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";

/** Expected workerd path for a userland DO ref (UniversalDO facet host). */
function userlandUrl(ref: DORef, methodPath: string): string {
  return `/_u/${encodeURIComponent(encodeUniversalKey(ref))}/${methodPath}`;
}

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
  it("routes a userland DO through the UniversalDO facet host (/_u/)", () => {
    const ref = makeRef();
    expect(doRefUrl(ref, "onChannelEvent")).toBe(userlandUrl(ref, "onChannelEvent"));
    // The packed key round-trips source|className|objectKey.
    expect(encodeUniversalKey(ref)).toBe("workers%2Fagent-worker|AiChatWorker|ch-123");
  });

  it("routes an internal DO through its static namespace (/_w/)", () => {
    const ref = makeRef({
      source: INTERNAL_DO_SOURCE,
      className: "WorkspaceDO",
      objectKey: "ws-1",
    });
    expect(doRefUrl(ref, "lifecycleListLeases")).toBe(
      `/_w/${INTERNAL_DO_SOURCE.split("/").map(encodeURIComponent).join("/")}/WorkspaceDO/ws-1/lifecycleListLeases`
    );
  });

  it("escapes special characters in the packed userland key", () => {
    const ref = makeRef({ className: "My Worker", objectKey: "key/with:special chars" });
    const url = doRefUrl(ref, "method");
    expect(url).toBe(userlandUrl(ref, "method"));
    // The packed key is opaque-encoded; decoding the segment recovers it.
    expect(decodeURIComponent(url.split("/")[2]!)).toBe(encodeUniversalKey(ref));
  });

  it("encodes method path segments while preserving method slashes", () => {
    const ref = makeRef();
    const url = doRefUrl(ref, "__lifecycle/some method");
    expect(url).toBe(userlandUrl(ref, "__lifecycle/some%20method"));
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
    it("calls the dispatcher with the correct URL path and args", async () => {
      const dispatcher = vi.fn().mockResolvedValue({ ok: true });
      dispatch.setDispatcher(dispatcher);

      const ref = makeRef();
      await dispatch.dispatch(ref, "onChannelEvent", "arg1", 42);

      expect(dispatcher).toHaveBeenCalledTimes(1);
      expect(dispatcher).toHaveBeenCalledWith(userlandUrl(makeRef(), "onChannelEvent"), [
        "arg1",
        42,
      ]);
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

      expect(dispatcher).toHaveBeenCalledWith(expect.any(String), []);
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

  describe("dispatch with token-backed workerd URL", () => {
    it("retries fetch failures after ensuring the DO and refreshes the workerd URL", async () => {
      const tokenManager = new TokenManager();
      const ensureDO = vi.fn().mockResolvedValue(undefined);
      const getWorkerdUrl = vi
        .fn()
        .mockReturnValueOnce("http://127.0.0.1:10001")
        .mockReturnValueOnce("http://127.0.0.1:10002");
      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new TypeError("fetch failed"))
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          })
        );

      vi.stubGlobal("fetch", fetchMock);
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(getWorkerdUrl);
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");
      dispatch.setEnsureDO(ensureDO);

      const ref = makeRef();
      await expect(dispatch.dispatch(ref, "ping", "arg")).resolves.toEqual({ ok: true });

      expect(ensureDO).toHaveBeenCalledWith(ref.source, ref.className, ref.objectKey);
      expect(fetchMock).toHaveBeenNthCalledWith(
        1,
        `http://127.0.0.1:10001${userlandUrl(ref, "ping")}`,
        expect.any(Object)
      );
      expect(fetchMock).toHaveBeenNthCalledWith(
        2,
        `http://127.0.0.1:10002${userlandUrl(ref, "ping")}`,
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer workerd-gateway-token",
            "X-NatStack-Dispatch-Secret": "dispatch-secret",
          }),
        })
      );
    });

    it("stamps verified server caller identity for lifecycle dispatch", async () => {
      const tokenManager = new TokenManager();
      const fetchMock = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })
      );

      vi.stubGlobal("fetch", fetchMock);
      dispatch.setTokenManager(tokenManager);
      dispatch.setGetWorkerdUrl(() => "http://127.0.0.1:10001");
      dispatch.setGetDispatchSecret(() => "dispatch-secret");
      dispatch.setGetWorkerdGatewayToken(() => "workerd-gateway-token");

      const ref = makeRef();
      await expect(
        dispatch.dispatchLifecycle(ref, "resume", {
          epoch: "epoch-1",
          previousGeneration: 1,
          currentGeneration: 2,
          reason: "planned",
        })
      ).resolves.toEqual({ ok: true });

      const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        `http://127.0.0.1:10001${userlandUrl(ref, "__lifecycle/resume")}`
      );
      expect(body["__caller"]).toEqual({ callerId: "main", callerKind: "server" });
      expect(body["__parentId"]).toBe("main");
    });
  });
});
