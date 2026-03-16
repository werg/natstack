/**
 * Tests for AI service.
 */

import { createAiService } from "../../server/services/aiService.js";
import type { ServiceContext } from "../../shared/serviceDispatcher.js";

describe("aiService", () => {
  const mockAiHandler = {
    getAvailableRoles: vi.fn().mockResolvedValue({ editor: true }),
    cancelStream: vi.fn(),
    initialize: vi.fn().mockResolvedValue(undefined),
    startTargetStream: vi.fn(),
  };
  const mockRpcServer = {
    createWsStreamTarget: vi.fn().mockReturnValue({ write: vi.fn(), end: vi.fn() }),
  };

  const mockContextFolderManager = {
    ensureContextFolder: vi.fn().mockResolvedValue("/tmp/test-context"),
  };

  const svc = createAiService({
    aiHandler: mockAiHandler as any,
    rpcServer: mockRpcServer as any,
    contextFolderManager: mockContextFolderManager as any,
  });
  const handler = svc.handler;

  const shellCtx: ServiceContext = { callerId: "shell", callerKind: "shell" };
  const panelCtx: ServiceContext = { callerId: "panel-1", callerKind: "panel" };
  const serverCtx: ServiceContext = { callerId: "srv", callerKind: "server" };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("listRoles calls aiHandler.getAvailableRoles()", async () => {
    const result = await handler(shellCtx, "listRoles", []);
    expect(mockAiHandler.getAvailableRoles).toHaveBeenCalled();
    expect(result).toEqual({ editor: true });
  });

  it("streamCancel calls aiHandler.cancelStream(streamId)", async () => {
    await handler(shellCtx, "streamCancel", ["stream-42"]);
    expect(mockAiHandler.cancelStream).toHaveBeenCalledWith("stream-42");
  });

  it("streamTextStart requires wsClient", async () => {
    const options = { model: "claude-3", messages: [] };
    await expect(handler(shellCtx, "streamTextStart", [options, "stream-99"])).rejects.toThrow(
      "AI streaming requires a WS connection",
    );
  });

  it("streamTextStart calls startTargetStream with wsClient", async () => {
    const options = { model: "claude-3", messages: [], contextId: "ctx-test-panel" };
    const wsCtx: ServiceContext = {
      ...panelCtx,
      wsClient: { ws: {}, callerId: "p1", callerKind: "panel" } as any,
    };
    await handler(wsCtx, "streamTextStart", [options, "stream-99"]);
    expect(mockRpcServer.createWsStreamTarget).toHaveBeenCalled();
    expect(mockAiHandler.startTargetStream).toHaveBeenCalled();
  });

  it("reinitialize throws for non-server callers and succeeds for server", async () => {
    await expect(handler(panelCtx, "reinitialize", [])).rejects.toThrow(
      "ai.reinitialize is restricted to server callers",
    );

    await handler(serverCtx, "reinitialize", []);
    expect(mockAiHandler.initialize).toHaveBeenCalled();
  });

  it("throws on unknown method", async () => {
    await expect(handler(shellCtx, "unknownMethod", [])).rejects.toThrow(
      "Unknown AI method: unknownMethod",
    );
  });
});
