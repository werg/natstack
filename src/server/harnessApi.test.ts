import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable, Writable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleHarnessApiRequest, type HarnessApiDeps } from "./harnessApi.js";

// ─── Request / Response mocking ──────────────────────────────────────────────

function mockRequest(method: string, url: string, body?: unknown): IncomingMessage {
  const readable = new Readable();
  if (body) readable.push(JSON.stringify(body));
  readable.push(null);
  return Object.assign(readable, {
    method,
    url,
    headers: { host: "localhost", authorization: "Bearer test-token" },
  }) as unknown as IncomingMessage;
}

function mockRequestNoAuth(method: string, url: string): IncomingMessage {
  const readable = new Readable();
  readable.push(null);
  return Object.assign(readable, {
    method,
    url,
    headers: { host: "localhost" },
  }) as unknown as IncomingMessage;
}

interface MockResponse extends ServerResponse {
  statusCode: number;
  body: string;
}

function mockResponse(): MockResponse {
  let body = "";
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      body += chunk.toString();
      callback();
    },
  });
  return Object.assign(writable, {
    statusCode: 200,
    body: "",
    headersSent: false,
    writeHead(status: number, _headers?: Record<string, string>) {
      (this as unknown as MockResponse).statusCode = status;
      return this;
    },
    end(data?: string) {
      if (data) body += data;
      (this as unknown as MockResponse).body = body;
    },
    getHeader() { return undefined; },
    setHeader() { return this; },
  }) as unknown as MockResponse;
}

function parseBody(res: MockResponse): unknown {
  return JSON.parse(res.body);
}

// ─── Mock deps factory ───────────────────────────────────────────────────────

function createMockDeps(overrides: Partial<HarnessApiDeps> = {}): HarnessApiDeps {
  return {
    harnessManager: {
      spawn: vi.fn().mockResolvedValue(undefined),
      waitForBridge: vi.fn().mockResolvedValue({ call: vi.fn().mockResolvedValue(undefined) }),
      getHarnessBridge: vi.fn(),
      getHarness: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    } as unknown as HarnessApiDeps["harnessManager"],
    doDispatch: {
      dispatch: vi.fn().mockResolvedValue(undefined),
    } as unknown as HarnessApiDeps["doDispatch"],
    contextFolderManager: {
      ensureContextFolder: vi.fn().mockResolvedValue("/tmp/test-ctx"),
    } as unknown as HarnessApiDeps["contextFolderManager"],
    workerdManager: {
      cloneDO: vi.fn().mockResolvedValue({ source: "workers/pubsub-channel", className: "PubSubChannel", objectKey: "forked" }),
    } as unknown as HarnessApiDeps["workerdManager"],
    validateToken: vi.fn().mockReturnValue({ valid: true, callerId: "test-caller", callerKind: "worker" }),
    ...overrides,
  };
}

// ─── Default DORef for spawn tests ───────────────────────────────────────────

const testDoRef = {
  source: "workers/agent-worker",
  className: "AiChatWorker",
  objectKey: "ch-abc",
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("handleHarnessApiRequest", () => {
  let deps: HarnessApiDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  // ── Routing / Auth ──────────────────────────────────────────────────────────

  describe("routing and auth", () => {
    it("returns false for non-harness paths", async () => {
      const req = mockRequest("GET", "/other/path");
      const res = mockResponse();

      const handled = await handleHarnessApiRequest(req, res, deps);
      expect(handled).toBe(false);
    });

    it("returns 401 for missing auth token", async () => {
      const req = mockRequestNoAuth("POST", "/harness/spawn");
      const res = mockResponse();

      const handled = await handleHarnessApiRequest(req, res, deps);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
      expect(parseBody(res)).toEqual({ error: "Unauthorized" });
    });

    it("returns 401 for invalid auth token", async () => {
      deps = createMockDeps({ validateToken: vi.fn().mockReturnValue(false) });
      const req = mockRequest("POST", "/harness/spawn");
      const res = mockResponse();

      const handled = await handleHarnessApiRequest(req, res, deps);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(401);
    });

    it("returns 404 for unknown harness sub-path", async () => {
      const req = mockRequest("GET", "/harness/unknown-route");
      const res = mockResponse();

      const handled = await handleHarnessApiRequest(req, res, deps);
      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    });
  });

  // ── POST /harness/spawn ─────────────────────────────────────────────────────

  describe("POST /harness/spawn", () => {
    it("spawns a harness and returns ok with harnessId", async () => {
      const req = mockRequest("POST", "/harness/spawn", {
        doRef: testDoRef,
        type: "claude-sdk",
        contextId: "ctx-1",
      });
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(200);
      const body = parseBody(res) as { ok: boolean; harnessId: string };
      expect(body.ok).toBe(true);
      expect(body.harnessId).toMatch(/^harness-/);

      // Should NOT dispatch registerHarness (DO does this locally now)
      expect(deps.doDispatch.dispatch).not.toHaveBeenCalledWith(
        testDoRef, "registerHarness",
        expect.anything(), expect.anything(),
      );

      // Should have spawned via harnessManager
      expect(deps.harnessManager.spawn).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "claude-sdk",
          contextId: "ctx-1",
        }),
      );

      // Should have waited for the bridge
      expect(deps.harnessManager.waitForBridge).toHaveBeenCalledWith(
        expect.stringMatching(/^harness-/),
      );

      // Should have notified the DO that harness is ready
      expect(deps.doDispatch.dispatch).toHaveBeenCalledWith(
        testDoRef, "onHarnessEvent",
        expect.stringMatching(/^harness-/),
        { type: "ready" },
      );
    });

    it("uses provided harnessId when given", async () => {
      const req = mockRequest("POST", "/harness/spawn", {
        doRef: testDoRef,
        type: "claude-sdk",
        contextId: "ctx-1",
        harnessId: "my-custom-id",
      });
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(200);
      const body = parseBody(res) as { ok: boolean; harnessId: string };
      expect(body.harnessId).toBe("my-custom-id");
    });

    it("with initialInput fires startTurn via bridge", async () => {
      const mockBridgeCall = vi.fn().mockResolvedValue(undefined);
      deps = createMockDeps({
        harnessManager: {
          ...createMockDeps().harnessManager,
          spawn: vi.fn().mockResolvedValue(undefined),
          waitForBridge: vi.fn().mockResolvedValue({ call: mockBridgeCall }),
        } as unknown as HarnessApiDeps["harnessManager"],
      });

      const initialInput = { content: "Hello!", senderId: "user-1" };

      const req = mockRequest("POST", "/harness/spawn", {
        doRef: testDoRef,
        type: "claude-sdk",
        contextId: "ctx-1",
        initialInput,
      });
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(200);

      // Should NOT dispatch recordTurnStart (DO does this locally now)
      expect(deps.doDispatch.dispatch).not.toHaveBeenCalledWith(
        testDoRef, "recordTurnStart",
        expect.anything(), expect.anything(), expect.anything(),
        expect.anything(), expect.anything(), expect.anything(),
      );

      // Should call bridge.startTurn (fire-and-forget)
      expect(mockBridgeCall).toHaveBeenCalledWith(
        expect.any(String),  // harnessId
        "startTurn",
        initialInput,
      );
    });

    it("returns 400 when required fields are missing", async () => {
      const req = mockRequest("POST", "/harness/spawn", {
        doRef: testDoRef,
        // missing type, contextId
      });
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(400);
      expect(parseBody(res)).toEqual({
        error: "Missing required fields: doRef, type, contextId",
      });
    });

    it("returns 500 on spawn failure", async () => {
      deps = createMockDeps({
        harnessManager: {
          ...createMockDeps().harnessManager,
          spawn: vi.fn().mockRejectedValue(new Error("spawn failed: out of memory")),
          stop: vi.fn().mockResolvedValue(undefined),
        } as unknown as HarnessApiDeps["harnessManager"],
      });

      const req = mockRequest("POST", "/harness/spawn", {
        doRef: testDoRef,
        type: "claude-sdk",
        contextId: "ctx-1",
      });
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(500);
      expect(parseBody(res)).toEqual({ error: "Error: spawn failed: out of memory" });

      // Should attempt to stop the harness on failure
      expect(deps.harnessManager.stop).toHaveBeenCalled();
    });
  });

  // ── POST /harness/{id}/command ──────────────────────────────────────────────

  describe("POST /harness/{id}/command", () => {
    it("forwards start-turn as fire-and-forget", async () => {
      const mockBridgeCall = vi.fn().mockResolvedValue(undefined);
      const mockBridge = { call: mockBridgeCall };
      deps = createMockDeps({
        harnessManager: {
          ...createMockDeps().harnessManager,
          getHarnessBridge: vi.fn().mockReturnValue(mockBridge),
        } as unknown as HarnessApiDeps["harnessManager"],
      });

      const req = mockRequest("POST", "/harness/h-1/command", {
        command: { type: "start-turn", input: { content: "Go", senderId: "u1" } },
      });
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(200);
      expect(parseBody(res)).toEqual({ ok: true });

      // bridge.call should have been invoked with startTurn
      expect(mockBridgeCall).toHaveBeenCalledWith("h-1", "startTurn", { content: "Go", senderId: "u1" });
    });

    it("forwards approve-tool and awaits the response", async () => {
      const mockBridgeCall = vi.fn().mockResolvedValue(undefined);
      const mockBridge = { call: mockBridgeCall };
      deps = createMockDeps({
        harnessManager: {
          ...createMockDeps().harnessManager,
          getHarnessBridge: vi.fn().mockReturnValue(mockBridge),
        } as unknown as HarnessApiDeps["harnessManager"],
      });

      const req = mockRequest("POST", "/harness/h-1/command", {
        command: { type: "approve-tool", toolUseId: "tool-1", allow: true, alwaysAllow: false },
      });
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(200);
      expect(mockBridgeCall).toHaveBeenCalledWith("h-1", "approveTool", "tool-1", true, false, undefined);
    });

    it("returns 404 when no bridge exists for the harness", async () => {
      deps = createMockDeps({
        harnessManager: {
          ...createMockDeps().harnessManager,
          getHarnessBridge: vi.fn().mockReturnValue(undefined),
        } as unknown as HarnessApiDeps["harnessManager"],
      });

      const req = mockRequest("POST", "/harness/nonexistent/command", {
        command: { type: "start-turn", input: {} },
      });
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(404);
      expect(parseBody(res)).toEqual({ error: "No bridge for harness nonexistent" });
    });

    it("returns 400 when command is missing", async () => {
      const mockBridge = { call: vi.fn() };
      deps = createMockDeps({
        harnessManager: {
          ...createMockDeps().harnessManager,
          getHarnessBridge: vi.fn().mockReturnValue(mockBridge),
        } as unknown as HarnessApiDeps["harnessManager"],
      });

      const req = mockRequest("POST", "/harness/h-1/command", {});
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(400);
      expect(parseBody(res)).toEqual({ error: "Missing command" });
    });

    it("returns 500 when a non-start-turn bridge call fails", async () => {
      const mockBridgeCall = vi.fn().mockRejectedValue(new Error("bridge error"));
      const mockBridge = { call: mockBridgeCall };
      deps = createMockDeps({
        harnessManager: {
          ...createMockDeps().harnessManager,
          getHarnessBridge: vi.fn().mockReturnValue(mockBridge),
        } as unknown as HarnessApiDeps["harnessManager"],
      });

      const req = mockRequest("POST", "/harness/h-1/command", {
        command: { type: "interrupt" },
      });
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(500);
      expect(parseBody(res)).toEqual({ error: "Error: bridge error" });
    });
  });

  // ── POST /harness/{id}/stop ─────────────────────────────────────────────────

  describe("POST /harness/{id}/stop", () => {
    it("calls harnessManager.stop and returns ok", async () => {
      const req = mockRequest("POST", "/harness/h-1/stop");
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(200);
      expect(parseBody(res)).toEqual({ ok: true });
      expect(deps.harnessManager.stop).toHaveBeenCalledWith("h-1");
    });
  });

  // ── GET /harness/{id}/status ────────────────────────────────────────────────

  describe("GET /harness/{id}/status", () => {
    it("returns harness status when found", async () => {
      deps = createMockDeps({
        harnessManager: {
          ...createMockDeps().harnessManager,
          getHarness: vi.fn().mockReturnValue({ status: "running", type: "claude-sdk" }),
        } as unknown as HarnessApiDeps["harnessManager"],
      });

      const req = mockRequest("GET", "/harness/h-1/status");
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(200);
      expect(parseBody(res)).toEqual({ status: "running", type: "claude-sdk" });
    });

    it("returns 404 when harness not found", async () => {
      deps = createMockDeps({
        harnessManager: {
          ...createMockDeps().harnessManager,
          getHarness: vi.fn().mockReturnValue(undefined),
        } as unknown as HarnessApiDeps["harnessManager"],
      });

      const req = mockRequest("GET", "/harness/missing/status");
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(404);
      expect(parseBody(res)).toEqual({ error: "Harness not found" });
    });
  });

  // ── POST /do/clone ─────────────────────────────────────────────────────────

  describe("POST /do/clone", () => {
    const channelRef = {
      source: "workers/pubsub-channel",
      className: "PubSubChannel",
      objectKey: "chan-original",
    };

    it("clones a DO and returns the new ref", async () => {
      const clonedRef = { ...channelRef, objectKey: "chan-clone" };
      const mockCloneDO = vi.fn().mockResolvedValue(clonedRef);
      deps = createMockDeps({
        workerdManager: {
          cloneDO: mockCloneDO,
        } as unknown as HarnessApiDeps["workerdManager"],
        validateToken: vi.fn().mockReturnValue({
          valid: true,
          callerId: "do-service:workers/pubsub-channel:PubSubChannel",
          callerKind: "worker",
        }),
      });

      const req = mockRequest("POST", "/do/clone", {
        ref: channelRef,
        newObjectKey: "chan-clone",
      });
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(200);
      expect(parseBody(res)).toEqual(clonedRef);
      expect(mockCloneDO).toHaveBeenCalledWith(channelRef, "chan-clone");
    });

    it("returns 403 when caller does not match ref class", async () => {
      deps = createMockDeps({
        validateToken: vi.fn().mockReturnValue({
          valid: true,
          callerId: "do-service:workers/other:OtherDO",
          callerKind: "worker",
        }),
      });

      const req = mockRequest("POST", "/do/clone", {
        ref: channelRef,
        newObjectKey: "chan-clone",
      });
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(403);
      expect(parseBody(res)).toEqual({ error: "Can only clone instances of your own class" });
    });

    it("returns 400 when required fields are missing", async () => {
      deps = createMockDeps({
        validateToken: vi.fn().mockReturnValue({
          valid: true,
          callerId: "do-service:workers/pubsub-channel:PubSubChannel",
          callerKind: "worker",
        }),
      });

      const req = mockRequest("POST", "/do/clone", {
        ref: { source: "workers/pubsub-channel" },
        // missing className, objectKey, newObjectKey
      });
      const res = mockResponse();

      await handleHarnessApiRequest(req, res, deps);

      expect(res.statusCode).toBe(400);
    });
  });
});
