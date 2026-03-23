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
          participantId: "panel-1",
          name: "eval",
          description: "Evaluate code",
          parameters: { type: "object", properties: { code: { type: "string" } } },
        },
        {
          participantId: "panel-1",
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
      // 2 discovered tools + 1 ask_user tool (from feedback_form presence)
      expect(sessionOptions.customTools).toHaveLength(3);
      expect(sessionOptions.customTools[0].name).toContain("eval");
      expect(sessionOptions.customTools[1].name).toContain("feedback_form");
      expect(sessionOptions.customTools[2].name).toBe("ask_user");
    });

    it("should skip menu-only methods", async () => {
      const methods: DiscoveredMethod[] = [
        {
          participantId: "panel-1",
          name: "eval",
          description: "Evaluate code",
        },
        {
          participantId: "panel-1",
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

  describe("tool approval", () => {
    it("should emit approval-needed and wait for approve-tool before executing", async () => {
      const methods: DiscoveredMethod[] = [
        {
          participantId: "panel-1",
          name: "eval",
          description: "Evaluate code",
          parameters: { type: "object", properties: { code: { type: "string" } } },
        },
      ];

      // Session that calls the tool's execute — simulate Pi SDK calling it
      let capturedTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
      const createSession = vi.fn().mockImplementation(async (options: { customTools?: unknown[] }) => {
        capturedTools = (options.customTools ?? []) as typeof capturedTools;
        return createMockPiSession([{ type: "agent_end" }]);
      });

      const deps = createDeps({
        discoverMethods: vi.fn().mockResolvedValue(methods),
        createSession,
      });
      const adapter = new PiAdapter(createConfig(), deps);

      // Start turn to create session and discover tools
      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      // Now call the wrapped tool directly (simulating Pi SDK calling execute)
      expect(capturedTools.length).toBeGreaterThan(0);
      const tool = capturedTools[0]!;

      // Start execution in background — it should block on approval
      let toolResult: unknown;
      const toolPromise = tool.execute("call-1", { code: "1+1" }, undefined, undefined, undefined)
        .then((r) => { toolResult = r; });

      // approval-needed should have been emitted
      const approvalEvent = deps.events.find(
        (e) => e.type === "approval-needed",
      );
      expect(approvalEvent).toBeDefined();

      // Approve the tool
      await adapter.handleCommand({
        type: "approve-tool",
        toolUseId: "call-1",
        allow: true,
        alwaysAllow: false,
      });
      await toolPromise;

      expect(toolResult).toBeDefined();
    });

    it("should return denial message when tool is rejected", async () => {
      const methods: DiscoveredMethod[] = [
        { participantId: "p1", name: "dangerous", description: "Dangerous op" },
      ];

      let capturedTools: Array<{ execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
      const createSession = vi.fn().mockImplementation(async (options: { customTools?: unknown[] }) => {
        capturedTools = (options.customTools ?? []) as typeof capturedTools;
        return createMockPiSession([{ type: "agent_end" }]);
      });

      const deps = createDeps({
        discoverMethods: vi.fn().mockResolvedValue(methods),
        createSession,
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      const tool = capturedTools[0]!;
      const resultPromise = tool.execute("call-2", {}, undefined, undefined, undefined);

      // Deny
      await adapter.handleCommand({
        type: "approve-tool",
        toolUseId: "call-2",
        allow: false,
        alwaysAllow: false,
      });

      const result = await resultPromise;
      expect(result.content[0]!.text).toContain("denied");
    });

    it("should auto-deny on abort signal", async () => {
      const methods: DiscoveredMethod[] = [
        { participantId: "p1", name: "slow_op", description: "Slow" },
      ];

      let capturedTools: Array<{ execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
      const createSession = vi.fn().mockImplementation(async (options: { customTools?: unknown[] }) => {
        capturedTools = (options.customTools ?? []) as typeof capturedTools;
        return createMockPiSession([{ type: "agent_end" }]);
      });

      const deps = createDeps({
        discoverMethods: vi.fn().mockResolvedValue(methods),
        createSession,
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      const tool = capturedTools[0]!;
      const abortController = new AbortController();

      // Start execution with an abort signal
      const resultPromise = tool.execute("call-3", {}, abortController.signal, undefined, undefined);

      // Abort — should auto-deny
      abortController.abort();

      const result = await resultPromise;
      expect(result.content[0]!.text).toContain("denied");
    });
  });

  describe("tool allowlist", () => {
    it("should filter tools by allowlist", async () => {
      const methods: DiscoveredMethod[] = [
        { participantId: "p1", name: "allowed_tool", description: "Allowed" },
        { participantId: "p1", name: "blocked_tool", description: "Blocked" },
        { participantId: "p1", name: "feedback_form", description: "Form" },
      ];

      const createSession = vi.fn().mockResolvedValue(
        createMockPiSession([{ type: "agent_end" }]),
      );

      const deps = createDeps({
        discoverMethods: vi.fn().mockResolvedValue(methods),
        createSession,
      });
      // Only allow "allowed_tool" — feedback_form is excluded
      const config = createConfig({ toolAllowlist: ["allowed_tool"] });
      const adapter = new PiAdapter(config, deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      const sessionOptions = createSession.mock.calls[0]![0]!;
      // Only 1 tool — allowed_tool. No ask_user because feedback_form is excluded.
      expect(sessionOptions.customTools).toHaveLength(1);
      expect(sessionOptions.customTools[0].name).toContain("allowed_tool");
    });
  });

  describe("per-turn settings", () => {
    it("should recreate session when model changes between turns", async () => {
      const piEvents: PiSessionEvent[] = [{ type: "agent_end" }];
      const session1 = createMockPiSession(piEvents, { sessionFile: "/s1.jsonl" });
      const session2 = createMockPiSession(piEvents, { sessionFile: "/s2.jsonl" });
      const createSession = vi.fn()
        .mockResolvedValueOnce(session1)
        .mockResolvedValueOnce(session2);
      const createSessionManager = vi.fn().mockReturnValue(createMockSessionManager());

      const deps = createDeps({ createSession, createSessionManager });
      const adapter = new PiAdapter(createConfig({ model: "model-a" }), deps);

      // Turn 1 with default model
      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "turn 1", senderId: "user-1" },
      });
      expect(createSession).toHaveBeenCalledTimes(1);
      expect(createSession.mock.calls[0]![0].model).toBe("model-a");

      // Turn 2 with different model — should recreate session
      await adapter.handleCommand({
        type: "start-turn",
        input: {
          content: "turn 2",
          senderId: "user-1",
          settings: { model: "model-b" },
        },
      });
      expect(createSession).toHaveBeenCalledTimes(2);
      expect(createSession.mock.calls[1]![0].model).toBe("model-b");
      // Should have resumed from session 1's file
      expect(createSessionManager).toHaveBeenLastCalledWith(
        expect.any(String),
        "/s1.jsonl",
      );
    });

    it("should reuse session when settings are unchanged", async () => {
      const piEvents: PiSessionEvent[] = [{ type: "agent_end" }];
      const mockSession = createMockPiSession(piEvents);
      const createSession = vi.fn().mockResolvedValue(mockSession);

      const deps = createDeps({ createSession });
      const adapter = new PiAdapter(createConfig({ model: "model-a" }), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "turn 1", senderId: "user-1" },
      });
      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "turn 2", senderId: "user-1" },
      });

      // Session created only once
      expect(createSession).toHaveBeenCalledTimes(1);
    });
  });

  describe("error recovery", () => {
    it("should emit turn-complete with sessionId after error", async () => {
      const mockSession = createMockPiSession([], {
        sessionFile: "/sessions/err.jsonl",
      });
      (mockSession as { prompt: unknown }).prompt = async () => {
        throw new Error("API error");
      };

      const deps = createDeps({
        createSession: vi.fn().mockResolvedValue(mockSession),
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      const errorEvt = deps.events.find((e) => e.type === "error");
      expect(errorEvt).toBeDefined();

      const turnComplete = deps.events.find((e) => e.type === "turn-complete");
      expect(turnComplete).toBeDefined();
      expect(
        (turnComplete as { sessionId: string }).sessionId,
      ).toBe("/sessions/err.jsonl");
    });
  });

  describe("approval ordering", () => {
    it("should defer action-start for approval-gated tools", async () => {
      const methods: DiscoveredMethod[] = [
        { participantId: "p1", name: "eval", description: "Eval" },
      ];

      let capturedTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
      const piEvents: PiSessionEvent[] = [
        { type: "agent_start" },
        // tool_execution_start fires before execute is called
        { type: "tool_execution_start", toolCallId: "tc-1", toolName: expect.stringContaining("eval") as unknown as string },
        { type: "tool_execution_end", toolCallId: "tc-1", toolName: "eval" },
        { type: "agent_end" },
      ];

      const createSession = vi.fn().mockImplementation(async (options: { customTools?: unknown[] }) => {
        capturedTools = (options.customTools ?? []) as typeof capturedTools;
        return createMockPiSession(piEvents);
      });

      const deps = createDeps({
        discoverMethods: vi.fn().mockResolvedValue(methods),
        createSession,
      });
      const adapter = new PiAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: "start-turn",
        input: { content: "test", senderId: "user-1" },
      });

      // tool_execution_start for an approval-gated tool should NOT have
      // emitted action-start (it's deferred to the execute wrapper)
      const actionStartFromEvent = deps.events.find(
        (e) => e.type === "action-start",
      );
      // action-start only appears if the execute wrapper was called
      // (in this mock, prompt() fires events but doesn't call execute)
      // so no action-start should appear
      expect(actionStartFromEvent).toBeUndefined();
    });
  });
});
