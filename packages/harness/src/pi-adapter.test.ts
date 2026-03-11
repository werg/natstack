import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  PiAdapter,
  type PiAdapterDeps,
  type PiSession,
  type PiSessionEvent,
  type PiSessionStats,
  type PiSessionManager,
} from "./pi-adapter.js";
import type {
  HarnessConfig,
  HarnessOutput,
} from "./types.js";
import type { DiscoveredMethod } from "./pi-tools.js";

// ---------------------------------------------------------------------------
// Mock Pi session
// ---------------------------------------------------------------------------

/**
 * Creates a mock PiSession that emits pre-configured events when prompt() is called.
 */
function createMockPiSession(
  events: PiSessionEvent[],
  options?: {
    sessionFile?: string;
    stats?: PiSessionStats;
  },
): PiSession {
  let listener: ((event: PiSessionEvent) => void) | null = null;
  let aborted = false;

  return {
    async prompt() {
      if (aborted) return;
      for (const event of events) {
        if (aborted) break;
        listener?.(event);
      }
    },
    async followUp() {},
    subscribe(cb) {
      listener = cb;
      return () => {
        listener = null;
      };
    },
    async abort() {
      aborted = true;
    },
    dispose() {},
    get sessionFile() {
      return options?.sessionFile ?? "/tmp/test-session.jsonl";
    },
    getSessionStats() {
      return (
        options?.stats ?? {
          tokens: { input: 100, output: 50, cacheRead: 10, cacheWrite: 5, total: 165 },
          cost: 0.01,
        }
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Mock SessionManager
// ---------------------------------------------------------------------------

function createMockSessionManager(
  options?: {
    sessionFile?: string;
    entries?: Array<{ id: string; parentId: string | null; type: string }>;
    branchedFile?: string;
  },
): PiSessionManager {
  return {
    getSessionFile() {
      return options?.sessionFile ?? "/tmp/test-session.jsonl";
    },
    getEntries() {
      return options?.entries ?? [
        { id: "entry-1", parentId: null, type: "message" },
        { id: "entry-2", parentId: "entry-1", type: "message" },
        { id: "entry-3", parentId: "entry-2", type: "message" },
      ];
    },
    getEntry(id: string) {
      return this.getEntries().find((e) => e.id === id);
    },
    createBranchedSession(_leafId: string) {
      return options?.branchedFile ?? "/tmp/forked-session.jsonl";
    },
  };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createDeps(
  overrides?: Partial<PiAdapterDeps>,
): PiAdapterDeps & { events: HarnessOutput[] } {
  const events: HarnessOutput[] = [];
  const mockSession = createMockPiSession([]);
  const mockSessionManager = createMockSessionManager();

  return {
    events,
    pushEvent: (event: HarnessOutput) => events.push(event),
    callMethod: vi.fn().mockResolvedValue({ success: true }),
    discoverMethods: vi.fn().mockResolvedValue([]),
    createSession: vi.fn().mockResolvedValue(mockSession),
    createSessionManager: vi.fn().mockReturnValue(mockSessionManager),
    log: {
      info: vi.fn(),
      error: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  };
}

function createConfig(overrides?: Partial<HarnessConfig>): HarnessConfig {
  return {
    systemPrompt: "You are a test assistant.",
    model: "anthropic:claude-opus-4-6",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PiAdapter", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("stream event mapping", () => {
    it("should map thinking events to thinking-start/delta/end", async () => {
      const piEvents: PiSessionEvent[] = [
        { type: "agent_start" },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: "Let me think...",
          },
        },
        {
          type: "message_update",
          assistantMessageEvent: {
            type: "thinking_delta",
            delta: " about this.",
          },
        },
        {
          type: "message_end",
          message: { content: [{ type: "text", text: "Response" }] },
        },
        { type: "agent_end" },
      ];

      const mockSession = createMockPiSession(piEvents);
      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "Hello", senderId: "user-1" },
      });

      const types = deps.events.map((e) => e.type);
      expect(types).toContain("thinking-start");
      expect(types).toContain("thinking-delta");
      expect(types).toContain("thinking-end");

      const thinkingDeltas = deps.events.filter(
        (e): e is Extract<HarnessOutput, { type: "thinking-delta" }> =>
          e.type === "thinking-delta",
      );
      expect(thinkingDeltas[0]!.content).toBe("Let me think...");
      expect(thinkingDeltas[1]!.content).toBe(" about this.");
    });

    it("should map text delta events to text-start/delta/end", async () => {
      const piEvents: PiSessionEvent[] = [
        { type: "agent_start" },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Hello, " },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "world!" },
        },
        { type: "message_end" },
        { type: "agent_end" },
      ];

      const mockSession = createMockPiSession(piEvents);
      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "Hi", senderId: "user-1" },
      });

      const types = deps.events.map((e) => e.type);
      expect(types).toContain("text-start");
      expect(types).toContain("text-delta");
      expect(types).toContain("text-end");

      const textDeltas = deps.events.filter(
        (e): e is Extract<HarnessOutput, { type: "text-delta" }> =>
          e.type === "text-delta",
      );
      expect(textDeltas.map((d) => d.content).join("")).toBe("Hello, world!");
    });

    it("should map tool execution events to action-start/end", async () => {
      const piEvents: PiSessionEvent[] = [
        { type: "agent_start" },
        {
          type: "tool_execution_start",
          toolCallId: "tool-1",
          toolName: "bash",
          args: { command: "ls -la" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "bash",
          result: "file1.ts\nfile2.ts",
          isError: false,
        },
        { type: "agent_end" },
      ];

      const mockSession = createMockPiSession(piEvents);
      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "List files", senderId: "user-1" },
      });

      const actionStart = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: "action-start" }> =>
          e.type === "action-start",
      );
      expect(actionStart).toBeDefined();
      expect(actionStart!.toolUseId).toBe("tool-1");

      const actionEnd = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: "action-end" }> =>
          e.type === "action-end",
      );
      expect(actionEnd).toBeDefined();
      expect(actionEnd!.toolUseId).toBe("tool-1");
    });

    it("should close thinking block before starting text block", async () => {
      const piEvents: PiSessionEvent[] = [
        { type: "agent_start" },
        {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "Hmm..." },
        },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Here is my response." },
        },
        { type: "message_end" },
        { type: "agent_end" },
      ];

      const mockSession = createMockPiSession(piEvents);
      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      const types = deps.events.map((e) => e.type);

      const thinkingStartIdx = types.indexOf("thinking-start");
      const thinkingEndIdx = types.indexOf("thinking-end");
      const textStartIdx = types.indexOf("text-start");
      const textEndIdx = types.indexOf("text-end");

      expect(thinkingStartIdx).toBeLessThan(thinkingEndIdx);
      expect(thinkingEndIdx).toBeLessThan(textStartIdx);
      expect(textStartIdx).toBeLessThan(textEndIdx);
    });

    it("should close open blocks before tool execution", async () => {
      const piEvents: PiSessionEvent[] = [
        { type: "agent_start" },
        {
          type: "message_update",
          assistantMessageEvent: { type: "thinking_delta", delta: "Let me check..." },
        },
        {
          type: "tool_execution_start",
          toolCallId: "tool-2",
          toolName: "read",
          args: { file_path: "/src/main.ts" },
        },
        {
          type: "tool_execution_end",
          toolCallId: "tool-2",
          toolName: "read",
        },
        { type: "agent_end" },
      ];

      const mockSession = createMockPiSession(piEvents);
      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "Read main.ts", senderId: "user-1" },
      });

      const types = deps.events.map((e) => e.type);

      // thinking-end must come before action-start
      const thinkingEndIdx = types.indexOf("thinking-end");
      const actionStartIdx = types.indexOf("action-start");
      expect(thinkingEndIdx).toBeLessThan(actionStartIdx);
    });

    it("should use message_end fallback when no text_delta events were received", async () => {
      const piEvents: PiSessionEvent[] = [
        { type: "agent_start" },
        { type: "message_start" },
        {
          type: "message_end",
          message: {
            content: [{ type: "text", text: "Fallback response" }],
          },
        },
        { type: "agent_end" },
      ];

      const mockSession = createMockPiSession(piEvents);
      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      const types = deps.events.map((e) => e.type);
      expect(types).toContain("text-start");
      expect(types).toContain("text-delta");
      expect(types).toContain("text-end");
      expect(types).toContain("message-complete");

      const delta = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: "text-delta" }> =>
          e.type === "text-delta",
      );
      expect(delta!.content).toBe("Fallback response");
    });

    it("should use text_end fallback when no text_delta events were received", async () => {
      const piEvents: PiSessionEvent[] = [
        { type: "agent_start" },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_end", content: "Full text from text_end" },
        },
        { type: "message_end" },
        { type: "agent_end" },
      ];

      const mockSession = createMockPiSession(piEvents);
      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      const types = deps.events.map((e) => e.type);
      expect(types).toContain("text-start");
      expect(types).toContain("text-delta");

      const delta = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: "text-delta" }> =>
          e.type === "text-delta",
      );
      expect(delta!.content).toBe("Full text from text_end");
    });

    it("should emit error event for Pi SDK errors", async () => {
      const piEvents: PiSessionEvent[] = [
        { type: "agent_start" },
        {
          type: "message_update",
          assistantMessageEvent: { type: "error", reason: "Rate limit exceeded" },
        },
        { type: "agent_end" },
      ];

      const mockSession = createMockPiSession(piEvents);
      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      const error = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: "error" }> =>
          e.type === "error",
      );
      expect(error).toBeDefined();
      expect(error!.error).toBe("Rate limit exceeded");
      expect(error!.code).toBe("PI_SDK_ERROR");
    });
  });

  describe("turn completion", () => {
    it("should emit turn-complete with session file as sessionId", async () => {
      const piEvents: PiSessionEvent[] = [
        { type: "agent_start" },
        {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "Done" },
        },
        { type: "message_end" },
        { type: "agent_end" },
      ];

      const mockSession = createMockPiSession(piEvents, {
        sessionFile: "/sessions/my-session.jsonl",
      });
      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      const turnComplete = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: "turn-complete" }> =>
          e.type === "turn-complete",
      );
      expect(turnComplete).toBeDefined();
      expect(turnComplete!.sessionId).toBe("/sessions/my-session.jsonl");
    });

    it("should include per-turn usage deltas", async () => {
      const piEvents: PiSessionEvent[] = [
        { type: "agent_start" },
        { type: "agent_end" },
      ];

      const mockSession = createMockPiSession(piEvents, {
        stats: {
          tokens: { input: 200, output: 100, cacheRead: 20, cacheWrite: 10, total: 330 },
          cost: 0.05,
        },
      });
      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      const turnComplete = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: "turn-complete" }> =>
          e.type === "turn-complete",
      );
      expect(turnComplete).toBeDefined();
      expect(turnComplete!.usage).toEqual({
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
      });
    });

    it("should emit error on prompt failure", async () => {
      const mockSession = createMockPiSession([]);
      (mockSession as { prompt: unknown }).prompt = async () => {
        throw new Error("API connection failed");
      };

      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      const error = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: "error" }> =>
          e.type === "error",
      );
      expect(error).toBeDefined();
      expect(error!.error).toBe("API connection failed");
    });
  });

  describe("JSONL session management", () => {
    it("should create a new session when no resumeSessionId is provided", async () => {
      const piEvents: PiSessionEvent[] = [{ type: "agent_end" }];
      const mockSession = createMockPiSession(piEvents);
      const createSessionManager = vi.fn().mockReturnValue(createMockSessionManager());

      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
        createSessionManager,
      });
      const adapter = new PiAdapter(createConfig(), deps, {
        contextFolderPath: "/project",
      });

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      expect(createSessionManager).toHaveBeenCalledWith("/project", undefined);
    });

    it("should resume session when resumeSessionId is provided", async () => {
      const piEvents: PiSessionEvent[] = [{ type: "agent_end" }];
      const mockSession = createMockPiSession(piEvents);
      const createSessionManager = vi.fn().mockReturnValue(createMockSessionManager());

      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
        createSessionManager,
      });
      const adapter = new PiAdapter(createConfig(), deps, {
        contextFolderPath: "/project",
        resumeSessionId: "/sessions/old-session.jsonl",
      });

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "continue", senderId: "user-1" },
      });

      expect(createSessionManager).toHaveBeenCalledWith(
        "/project",
        "/sessions/old-session.jsonl",
      );
    });
  });

  describe("fork", () => {
    it("should create branched session and emit turn-complete with new file", async () => {
      const mockSM = createMockSessionManager({
        entries: [
          { id: "msg-1", parentId: null, type: "message" },
          { id: "msg-2", parentId: "msg-1", type: "message" },
          { id: "msg-3", parentId: "msg-2", type: "message" },
        ],
        branchedFile: "/sessions/forked.jsonl",
      });

      const deps = createDeps({
        createSessionManager: vi.fn().mockReturnValue(mockSM),
      });
      const adapter = new PiAdapter(createConfig(), deps, {
        contextFolderPath: "/project",
      });

      await adapter.handleCommand({
        type: "fork",
        forkPointMessageId: 1,
        turnSessionId: "/sessions/original.jsonl",
      });

      const turnComplete = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: "turn-complete" }> =>
          e.type === "turn-complete",
      );
      expect(turnComplete).toBeDefined();
      expect(turnComplete!.sessionId).toBe("/sessions/forked.jsonl");
    });

    it("should emit error when turnSessionId is empty", async () => {
      const deps = createDeps();
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "fork",
        forkPointMessageId: 0,
        turnSessionId: "",
      });

      const error = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: "error" }> =>
          e.type === "error",
      );
      expect(error).toBeDefined();
      expect(error!.code).toBe("FORK_NO_SESSION");
    });

    it("should handle fork when no entries exist", async () => {
      const mockSM = createMockSessionManager({ entries: [] });
      const deps = createDeps({
        createSessionManager: vi.fn().mockReturnValue(mockSM),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "fork",
        forkPointMessageId: 0,
        turnSessionId: "/sessions/empty.jsonl",
      });

      const error = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: "error" }> =>
          e.type === "error",
      );
      expect(error).toBeDefined();
      expect(error!.code).toBe("FORK_NO_ENTRY");
    });
  });

  describe("interrupt", () => {
    it("should call session.abort() on interrupt", async () => {
      let promptResolved = false;
      const abortFn = vi.fn();
      const blockingPromise = new Promise<void>((resolve) => {
        // The abort will resolve this
        abortFn.mockImplementation(async () => {
          resolve();
        });
      });

      const mockSession: PiSession = {
        async prompt() {
          await blockingPromise;
          promptResolved = true;
        },
        async followUp() {},
        subscribe() {
          return () => {};
        },
        abort: abortFn,
        dispose() {},
        get sessionFile() {
          return "/tmp/test.jsonl";
        },
        getSessionStats() {
          return {
            tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            cost: 0,
          };
        },
      };

      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      // Start turn in background
      const turnPromise = adapter.handleCommand({
        type: "start-turn",
        input: { content: "think deeply", senderId: "user-1" },
      });

      // Give the turn a tick to start
      await new Promise((r) => setTimeout(r, 10));

      // Interrupt
      await adapter.handleCommand({ type: "interrupt" });

      // Wait for turn to complete
      await turnPromise;

      expect(abortFn).toHaveBeenCalled();
      expect(promptResolved).toBe(true);
    });
  });

  describe("tool discovery", () => {
    it("should discover methods and pass as custom tools to session", async () => {
      const methods: DiscoveredMethod[] = [
        {
          providerId: "panel-1",
          providerName: "Panel",
          name: "eval",
          description: "Evaluate code",
          parameters: { type: "object", properties: { code: { type: "string" } } },
        },
        {
          providerId: "panel-1",
          providerName: "Panel",
          name: "feedback_form",
          description: "Show a form",
          parameters: {},
        },
      ];

      const piEvents: PiSessionEvent[] = [{ type: "agent_end" }];
      const mockSession = createMockPiSession(piEvents);
      const createSession = vi.fn().mockResolvedValue(mockSession);

      const deps = createDeps({
        discoverMethods: vi.fn().mockResolvedValue(methods),
        createSession,
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      expect(createSession).toHaveBeenCalledTimes(1);
      const sessionOptions = createSession.mock.calls[0]![0]!;
      expect(sessionOptions.customTools).toHaveLength(2);
      expect(sessionOptions.customTools[0].name).toContain("eval");
      expect(sessionOptions.customTools[1].name).toContain("feedback_form");
    });

    it("should skip menu-only methods", async () => {
      const methods: DiscoveredMethod[] = [
        {
          providerId: "panel-1",
          providerName: "Panel",
          name: "eval",
          description: "Evaluate code",
        },
        {
          providerId: "panel-1",
          providerName: "Panel",
          name: "settings_menu",
          description: "Open settings",
          menu: true,
        },
      ];

      const piEvents: PiSessionEvent[] = [{ type: "agent_end" }];
      const mockSession = createMockPiSession(piEvents);
      const createSession = vi.fn().mockResolvedValue(mockSession);

      const deps = createDeps({
        discoverMethods: vi.fn().mockResolvedValue(methods),
        createSession,
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      const sessionOptions = createSession.mock.calls[0]![0]!;
      expect(sessionOptions.customTools).toHaveLength(1);
      expect(sessionOptions.customTools[0].name).toContain("eval");
    });
  });

  describe("dispose", () => {
    it("should dispose session and clean up state", async () => {
      const piEvents: PiSessionEvent[] = [
        { type: "agent_start" },
        { type: "agent_end" },
      ];
      const disposeFn = vi.fn();
      const mockSession = createMockPiSession(piEvents);
      (mockSession as { dispose: unknown }).dispose = disposeFn;

      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      // Start a turn to create a session
      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      // Dispose
      await adapter.handleCommand({ type: "dispose" });

      expect(disposeFn).toHaveBeenCalled();
    });
  });
});
