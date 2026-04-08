import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ClaudeSdkAdapter, type ClaudeAdapterDeps, type DiscoveredMethod } from './claude-sdk-adapter.js';
import type { HarnessConfig, HarnessOutput, HarnessCommand } from './types.js';

// ---------------------------------------------------------------------------
// Mock SDK
// ---------------------------------------------------------------------------

/**
 * Creates a mock async generator that yields pre-configured SDK messages.
 * The returned object also exposes an `interrupt` method.
 */
function createMockQuery(messages: Array<Record<string, unknown>>) {
  let interrupted = false;

  const generator = (async function* () {
    for (const msg of messages) {
      if (interrupted) return;
      yield msg;
    }
  })() as AsyncGenerator<Record<string, unknown>, void> & { interrupt(): Promise<void> };

  generator.interrupt = async () => {
    interrupted = true;
  };

  return generator;
}

/**
 * Install a mock for the dynamic `import('@anthropic-ai/claude-agent-sdk')`.
 *
 * Since ClaudeSdkAdapter uses dynamic import, we mock it at the module level.
 */
function mockSdkModule(queryFactory: (params: { prompt: string; options?: Record<string, unknown> }) => ReturnType<typeof createMockQuery>) {
  vi.doMock('@anthropic-ai/claude-agent-sdk', () => ({
    query: queryFactory,
    tool: (name: string, description: string, _schema: unknown, handler: unknown) => ({
      name,
      description,
      handler,
    }),
    createSdkMcpServer: (options: { name: string; version?: string; tools?: unknown[] }) => ({
      type: 'sdk',
      name: options.name,
      instance: { tools: options.tools },
    }),
  }));
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createDeps(overrides?: Partial<ClaudeAdapterDeps>): ClaudeAdapterDeps & { events: HarnessOutput[] } {
  const events: HarnessOutput[] = [];
  return {
    events,
    pushEvent: async (event: HarnessOutput) => { events.push(event); },
    callMethod: vi.fn().mockResolvedValue({ success: true }),
    discoverMethods: vi.fn().mockResolvedValue([]),
    log: {
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    ...overrides,
  };
}

function createConfig(overrides?: Partial<HarnessConfig>): HarnessConfig {
  return {
    model: 'claude-sonnet-4-5-20250929',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeSdkAdapter', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe('stream event mapping', () => {
    it('should map thinking block events to thinking-start/delta/end', async () => {
      const sdkMessages = [
        {
          type: 'stream_event',
          session_id: 'sess-1',
          event: { type: 'message_start' },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'thinking' },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'Let me think...' },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: ' about this.' },
          },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_stop' },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-1',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      ];

      mockSdkModule(() => createMockQuery(sdkMessages));

      // Re-import to pick up the mock
      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: 'start-turn',
        input: {
          content: 'Hello',
          senderId: 'user-1',
        },
      });

      const types = deps.events.map((e) => e.type);
      expect(types).toContain('thinking-start');
      expect(types).toContain('thinking-delta');
      expect(types).toContain('thinking-end');
      expect(types).toContain('turn-complete');

      // Check thinking delta content
      const thinkingDeltas = deps.events.filter(
        (e): e is Extract<HarnessOutput, { type: 'thinking-delta' }> =>
          e.type === 'thinking-delta',
      );
      expect(thinkingDeltas[0]!.content).toBe('Let me think...');
      expect(thinkingDeltas[1]!.content).toBe(' about this.');

      // Check turn-complete includes session ID and usage
      const turnComplete = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: 'turn-complete' }> =>
          e.type === 'turn-complete',
      );
      expect(turnComplete).toBeDefined();
      expect(turnComplete!.sessionId).toBe('sess-1');
      expect(turnComplete!.usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      });
    });

    it('should map text block events to text-start/delta/end', async () => {
      const sdkMessages = [
        {
          type: 'stream_event',
          session_id: 'sess-2',
          event: { type: 'message_start' },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'text' },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Hello, ' },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'world!' },
          },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_stop' },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-2',
          usage: { input_tokens: 50, output_tokens: 25 },
        },
      ];

      mockSdkModule(() => createMockQuery(sdkMessages));

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: 'start-turn',
        input: { content: 'Hi', senderId: 'user-1' },
      });

      const types = deps.events.map((e) => e.type);
      expect(types).toContain('text-start');
      expect(types).toContain('text-delta');
      expect(types).toContain('text-end');

      const textDeltas = deps.events.filter(
        (e): e is Extract<HarnessOutput, { type: 'text-delta' }> =>
          e.type === 'text-delta',
      );
      expect(textDeltas.map((d) => d.content).join('')).toBe('Hello, world!');
    });

    it('should map tool_use blocks to action-start/action-end', async () => {
      const sdkMessages = [
        {
          type: 'stream_event',
          session_id: 'sess-3',
          event: { type: 'message_start' },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tool-1', name: 'Read' },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{"file_path":' },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '"/src/main.ts"}' },
          },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_stop' },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-3',
          usage: { input_tokens: 200, output_tokens: 100 },
        },
      ];

      mockSdkModule(() => createMockQuery(sdkMessages));

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: 'start-turn',
        input: { content: 'Read main.ts', senderId: 'user-1' },
      });

      const actionStart = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: 'action-start' }> =>
          e.type === 'action-start',
      );
      expect(actionStart).toBeDefined();
      expect(actionStart!.tool).toBe('Read');
      expect(actionStart!.toolUseId).toBe('tool-1');
      expect(actionStart!.description).toBe('Reading /src/main.ts');

      const actionEnd = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: 'action-end' }> =>
          e.type === 'action-end',
      );
      expect(actionEnd).toBeDefined();
      expect(actionEnd!.toolUseId).toBe('tool-1');
    });

    it('should emit action beads for subagent tool_use blocks', async () => {
      const sdkMessages = [
        {
          type: 'stream_event',
          session_id: 'sess-4',
          parent_tool_use_id: 'subagent-tool-1',
          event: { type: 'content_block_start', content_block: { type: 'tool_use', id: 'sub-tu-1', name: 'Read' } },
        },
        {
          type: 'stream_event',
          session_id: 'sess-4',
          parent_tool_use_id: 'subagent-tool-1',
          event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{"file_path":"/src/foo.ts"}' } },
        },
        {
          type: 'stream_event',
          session_id: 'sess-4',
          parent_tool_use_id: 'subagent-tool-1',
          event: { type: 'content_block_stop' },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-4',
          usage: { input_tokens: 50, output_tokens: 30 },
        },
      ];

      mockSdkModule(() => createMockQuery(sdkMessages));

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: 'start-turn',
        input: { content: 'Run subagent', senderId: 'user-1' },
      });

      const actionStart = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: 'action-start' }> =>
          e.type === 'action-start' && e.toolUseId === 'sub-tu-1',
      );
      expect(actionStart).toBeDefined();
      expect(actionStart!.tool).toBe('Read');
      expect(actionStart!.description).toBe('Reading /src/foo.ts');

      const actionEnd = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: 'action-end' }> =>
          e.type === 'action-end' && e.toolUseId === 'sub-tu-1',
      );
      expect(actionEnd).toBeDefined();
    });

    it('should handle error result messages', async () => {
      const sdkMessages = [
        {
          type: 'result',
          subtype: 'error_during_execution',
          session_id: 'sess-5',
          errors: ['Something went wrong', 'Additional detail'],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ];

      mockSdkModule(() => createMockQuery(sdkMessages));

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: 'start-turn',
        input: { content: 'fail', senderId: 'user-1' },
      });

      const error = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: 'error' }> =>
          e.type === 'error',
      );
      expect(error).toBeDefined();
      expect(error!.error).toBe('Something went wrong; Additional detail');
      expect(error!.code).toBe('error_during_execution');

      // Should still emit turn-complete for recovery
      const turnComplete = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: 'turn-complete' }> =>
          e.type === 'turn-complete',
      );
      expect(turnComplete).toBeDefined();
      expect(turnComplete!.sessionId).toBe('sess-5');
    });

    it('should handle non-streamed assistant messages as fallback', async () => {
      const sdkMessages = [
        {
          type: 'assistant',
          session_id: 'sess-6',
          message: {
            content: [
              { type: 'text', text: 'Fallback response text' },
            ],
          },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-6',
          usage: { input_tokens: 20, output_tokens: 10 },
        },
      ];

      mockSdkModule(() => createMockQuery(sdkMessages));

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: 'start-turn',
        input: { content: 'test', senderId: 'user-1' },
      });

      const types = deps.events.map((e) => e.type);
      expect(types).toContain('text-start');
      expect(types).toContain('text-delta');
      expect(types).toContain('text-end');
      expect(types).toContain('message-complete');

      const delta = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: 'text-delta' }> =>
          e.type === 'text-delta',
      );
      expect(delta!.content).toBe('Fallback response text');
    });
  });

  describe('interrupt', () => {
    it('should call SDK interrupt and abort the turn', async () => {
      const interruptFn = vi.fn();
      let resolveBlock: (() => void) | undefined;
      const blockingPromise = new Promise<void>((resolve) => {
        resolveBlock = resolve;
      });

      // Create a query that blocks until manually resolved
      const mockQuery = (async function* () {
        yield {
          type: 'stream_event',
          session_id: 'sess-int',
          event: { type: 'message_start' },
        };
        yield {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'text' },
          },
        };
        // Block here to simulate long-running query
        await blockingPromise;
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-int',
          usage: { input_tokens: 10, output_tokens: 5 },
        };
      })() as AsyncGenerator<Record<string, unknown>, void> & { interrupt(): Promise<void> };

      mockQuery.interrupt = async () => {
        interruptFn();
        resolveBlock!();
      };

      mockSdkModule(() => mockQuery);

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(createConfig(), deps);

      // Start turn in background
      const turnPromise = adapter.handleCommand({
        type: 'start-turn',
        input: { content: 'think deeply', senderId: 'user-1' },
      });

      // Wait for the mock query to start streaming (events prove the query is active)
      while (deps.events.length < 1) {
        await new Promise((r) => setTimeout(r, 5));
      }

      // Interrupt
      await adapter.handleCommand({ type: 'interrupt' });

      // Wait for turn to complete
      await turnPromise;

      expect(interruptFn).toHaveBeenCalled();
    });
  });

  describe('session management', () => {
    it('should capture session ID from result and expose via getSessionId', async () => {
      const sdkMessages = [
        {
          type: 'result',
          subtype: 'success',
          session_id: 'captured-session-42',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ];

      mockSdkModule(() => createMockQuery(sdkMessages));

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(createConfig(), deps);

      expect(adapter.getSessionId()).toBeUndefined();

      await adapter.handleCommand({
        type: 'start-turn',
        input: { content: 'test', senderId: 'user-1' },
      });

      expect(adapter.getSessionId()).toBe('captured-session-42');
    });

    it('should initialize with resumeSessionId option', async () => {
      const sdkMessages = [
        {
          type: 'result',
          subtype: 'success',
          session_id: 'resumed-session',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ];

      let capturedOptions: Record<string, unknown> | undefined;
      mockSdkModule((params) => {
        capturedOptions = params.options;
        return createMockQuery(sdkMessages);
      });

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(createConfig(), deps, {
        resumeSessionId: 'old-session-id',
      });

      expect(adapter.getSessionId()).toBe('old-session-id');

      await adapter.handleCommand({
        type: 'start-turn',
        input: { content: 'continue', senderId: 'user-1' },
      });

      // Should have passed resume option to SDK
      expect(capturedOptions?.["resume"]).toBe('old-session-id');
    });
  });

  describe('dispose', () => {
    it('should reject commands after dispose', async () => {
      const sdkMessages = [
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-disp',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ];

      mockSdkModule(() => createMockQuery(sdkMessages));

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(createConfig(), deps);

      await adapter.handleCommand({ type: 'dispose' });

      await adapter.handleCommand({
        type: 'start-turn',
        input: { content: 'should fail', senderId: 'user-1' },
      });

      const error = deps.events.find(
        (e): e is Extract<HarnessOutput, { type: 'error' }> =>
          e.type === 'error',
      );
      expect(error).toBeDefined();
      expect(error!.error).toContain('disposed');
    });
  });

  describe('MCP tool discovery', () => {
    it('should discover methods and build MCP servers', async () => {
      const discoveredMethods: DiscoveredMethod[] = [
        {
          participantId: 'panel-1',
          name: 'eval',
          description: 'Evaluate code',
          parameters: { type: 'object', properties: { code: { type: 'string' } } },
        },
      ];

      const sdkMessages = [
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-mcp',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ];

      let capturedOptions: Record<string, unknown> | undefined;
      mockSdkModule((params) => {
        capturedOptions = params.options;
        return createMockQuery(sdkMessages);
      });

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps({
        discoverMethods: vi.fn().mockResolvedValue(discoveredMethods),
      });
      const adapter = new MockedAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: 'start-turn',
        input: { content: 'test', senderId: 'user-1' },
      });

      // Should have called discoverMethods
      expect(deps.discoverMethods).toHaveBeenCalled();

      // Should have passed mcpServers to query options
      expect(capturedOptions?.["mcpServers"]).toBeDefined();
      const servers = capturedOptions!["mcpServers"] as Record<string, unknown>;
      expect(servers['workspace']).toBeDefined();
    });
  });

  describe('system prompt', () => {
    it('should always use the Claude Code preset prompt', async () => {
      const sdkMessages = [
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-sp',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ];

      let capturedOptions: Record<string, unknown> | undefined;
      mockSdkModule((params) => {
        capturedOptions = params.options;
        return createMockQuery(sdkMessages);
      });

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(
        createConfig({ systemPrompt: 'Custom system prompt here.' }),
        deps,
      );

      await adapter.handleCommand({
        type: 'start-turn',
        input: { content: 'test', senderId: 'user-1' },
      });

      expect(capturedOptions?.["systemPrompt"]).toEqual({
        type: 'preset',
        preset: 'claude_code',
      });
    });

    it('should ignore custom systemPrompt config', async () => {
      const sdkMessages = [
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-sp2',
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      ];

      let capturedOptions: Record<string, unknown> | undefined;
      mockSdkModule((params) => {
        capturedOptions = params.options;
        return createMockQuery(sdkMessages);
      });

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(
        createConfig({ systemPrompt: 'Full replacement prompt.', systemPromptMode: 'replace' }),
        deps,
      );

      await adapter.handleCommand({
        type: 'start-turn',
        input: { content: 'test', senderId: 'user-1' },
      });

      expect(capturedOptions?.["systemPrompt"]).toEqual({
        type: 'preset',
        preset: 'claude_code',
      });
    });
  });

  describe('thinking → text transitions', () => {
    it('should properly close thinking before opening text', async () => {
      const sdkMessages = [
        {
          type: 'stream_event',
          session_id: 'sess-tr',
          event: { type: 'message_start' },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'thinking' },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'thinking_delta', thinking: 'Hmm...' },
          },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_stop' },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_start',
            content_block: { type: 'text' },
          },
        },
        {
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'Here is my response.' },
          },
        },
        {
          type: 'stream_event',
          event: { type: 'content_block_stop' },
        },
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-tr',
          usage: { input_tokens: 100, output_tokens: 50 },
        },
      ];

      mockSdkModule(() => createMockQuery(sdkMessages));

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(createConfig(), deps);

      await adapter.handleCommand({
        type: 'start-turn',
        input: { content: 'test', senderId: 'user-1' },
      });

      const types = deps.events.map((e) => e.type);

      // Verify correct ordering: thinking block then text block
      const thinkingStartIdx = types.indexOf('thinking-start');
      const thinkingEndIdx = types.indexOf('thinking-end');
      const textStartIdx = types.indexOf('text-start');
      const textEndIdx = types.indexOf('text-end');

      expect(thinkingStartIdx).toBeLessThan(thinkingEndIdx);
      expect(thinkingEndIdx).toBeLessThan(textStartIdx);
      expect(textStartIdx).toBeLessThan(textEndIdx);
    });
  });

  describe('turn queueing', () => {
    it('queues second startTurn and processes sequentially', async () => {
      let queryCount = 0;
      mockSdkModule(() => {
        queryCount++;
        return createMockQuery([
          { type: 'stream_event', session_id: `sess-${queryCount}`, event: { type: 'message_start' } },
          { type: 'result', subtype: 'success', session_id: `sess-${queryCount}`, usage: { input_tokens: 1, output_tokens: 1 } },
        ]);
      });

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(createConfig(), deps);

      // Send two turns — both should complete
      await adapter.handleCommand({ type: 'start-turn', input: { content: 'first', senderId: 'u1' } });
      // The second was queued and auto-drained
      await new Promise((r) => setTimeout(r, 50)); // let drain settle

      expect(queryCount).toBe(1); // only one query because second wasn't queued during first

      // Now test actual concurrent queueing
      let resolveFirst: (() => void) | undefined;
      let firstQueryCount = 0;
      mockSdkModule(() => {
        firstQueryCount++;
        if (firstQueryCount === 1) {
          // First query blocks until resolved
          const gen = (async function* () {
            yield { type: 'stream_event', session_id: 'sess-a', event: { type: 'message_start' } };
            await new Promise<void>(r => { resolveFirst = r; });
            yield { type: 'result', subtype: 'success', session_id: 'sess-a', usage: { input_tokens: 1, output_tokens: 1 } };
          })() as AsyncGenerator<Record<string, unknown>, void> & { interrupt(): Promise<void> };
          gen.interrupt = async () => {};
          return gen;
        }
        return createMockQuery([
          { type: 'stream_event', session_id: 'sess-b', event: { type: 'message_start' } },
          { type: 'result', subtype: 'success', session_id: 'sess-b', usage: { input_tokens: 1, output_tokens: 1 } },
        ]);
      });

      const { ClaudeSdkAdapter: MockedAdapter2 } = await import('./claude-sdk-adapter.js');
      const deps2 = createDeps();
      const adapter2 = new MockedAdapter2(createConfig(), deps2);

      // Start first turn (blocks)
      const firstTurn = adapter2.handleCommand({ type: 'start-turn', input: { content: 'first', senderId: 'u1' } });

      // Wait for first query to start
      while (!resolveFirst) await new Promise(r => setTimeout(r, 5));

      // Queue second turn
      void adapter2.handleCommand({ type: 'start-turn', input: { content: 'second', senderId: 'u1' } });
      expect(firstQueryCount).toBe(1); // second hasn't started yet

      // Unblock first
      resolveFirst!();
      await firstTurn;
      await new Promise(r => setTimeout(r, 50));

      expect(firstQueryCount).toBe(2); // second ran after first completed

      // Verify two turn-completes
      const turnCompletes = deps2.events.filter(e => e.type === 'turn-complete');
      expect(turnCompletes.length).toBe(2);
    });

    it('emits fallback turn-complete on interrupt', async () => {
      let resolveBlock: (() => void) | undefined;
      const gen = (async function* () {
        yield { type: 'stream_event', session_id: 'sess-int', event: { type: 'message_start' } };
        await new Promise<void>(r => { resolveBlock = r; });
      })() as AsyncGenerator<Record<string, unknown>, void> & { interrupt(): Promise<void> };
      gen.interrupt = async () => { resolveBlock!(); };

      mockSdkModule(() => gen);
      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(createConfig(), deps);

      const turnPromise = adapter.handleCommand({ type: 'start-turn', input: { content: 'test', senderId: 'u1' } });
      while (!resolveBlock) await new Promise(r => setTimeout(r, 5));

      await adapter.handleCommand({ type: 'interrupt' });
      await turnPromise;

      // Should have a turn-complete even though no result message
      const turnCompletes = deps.events.filter(e => e.type === 'turn-complete');
      expect(turnCompletes.length).toBe(1);
      expect((turnCompletes[0] as { sessionId: string }).sessionId).toBe('sess-int');
    });

    it('dispose clears queue and prevents further turns', async () => {
      let resolveBlock: (() => void) | undefined;
      let queryCount = 0;
      mockSdkModule(() => {
        queryCount++;
        if (queryCount === 1) {
          const gen = (async function* () {
            yield { type: 'stream_event', session_id: 'sess-d', event: { type: 'message_start' } };
            await new Promise<void>(r => { resolveBlock = r; });
            yield { type: 'result', subtype: 'success', session_id: 'sess-d', usage: { input_tokens: 1, output_tokens: 1 } };
          })() as AsyncGenerator<Record<string, unknown>, void> & { interrupt(): Promise<void> };
          gen.interrupt = async () => { resolveBlock!(); };
          return gen;
        }
        return createMockQuery([
          { type: 'result', subtype: 'success', session_id: 'sess-d2', usage: { input_tokens: 1, output_tokens: 1 } },
        ]);
      });

      const { ClaudeSdkAdapter: MockedAdapter } = await import('./claude-sdk-adapter.js');
      const deps = createDeps();
      const adapter = new MockedAdapter(createConfig(), deps);

      const turnPromise = adapter.handleCommand({ type: 'start-turn', input: { content: 'first', senderId: 'u1' } });
      while (!resolveBlock) await new Promise(r => setTimeout(r, 5));

      // Queue a second turn
      void adapter.handleCommand({ type: 'start-turn', input: { content: 'second', senderId: 'u1' } });

      // Dispose — should clear queue and interrupt
      await adapter.handleCommand({ type: 'dispose' });
      await turnPromise;
      await new Promise(r => setTimeout(r, 50));

      // Second turn should NOT have run
      expect(queryCount).toBe(1);
    });
  });
});
