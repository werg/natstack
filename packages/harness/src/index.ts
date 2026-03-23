export { toChannelEvent } from './types.js';
export type {
  TurnUsage,
  HarnessOutput,
  HarnessSettings,
  HarnessConfig,
  Attachment,
  ChannelEvent,
  ChannelBroadcastEventRaw,
  SendMessageOptions,
  TurnInput,
  HarnessCommand,
  ParticipantDescriptor,
  MethodAdvertisement,
  UnsubscribeResult,
} from './types.js';

// Claude SDK adapter
export { ClaudeSdkAdapter } from './claude-sdk-adapter.js';
export type { ClaudeAdapterDeps, ClaudeAdapterOptions, DiscoveredMethod } from './claude-sdk-adapter.js';

// Pi adapter
export { PiAdapter } from './pi-adapter.js';
export type {
  PiAdapterDeps,
  PiAdapterOptions,
  PiSession,
  PiSessionEvent,
  PiSessionStats,
  PiSessionManager,
  PiImageContent,
  CreatePiSessionOptions,
} from './pi-adapter.js';

// Pi tool conversion
export { convertToPiTools } from './pi-tools.js';
export type {
  DiscoveredMethod as PiDiscoveredMethod,
  PiToolDefinition,
  ConvertToolsOptions,
  ConvertToolsResult,
} from './pi-tools.js';

// System prompt utilities
export { buildSystemPrompt, prependContextNote } from './system-prompt.js';

// MCP tool utilities
export { buildMcpToolDefinitions } from './mcp-tools.js';
export type { McpToolDefinition } from './mcp-tools.js';

// Harness transport (WebSocket RPC transport for child processes)
export { createHarnessTransport } from './harness-transport.js';
export type { HarnessTransportResult } from './harness-transport.js';

// Tool bridge (SDK-compatible tool executors via RPC)
export { discoverAndCreateTools, createToolExecutor } from './tool-bridge.js';
export type { ToolBridgeDeps } from './tool-bridge.js';
