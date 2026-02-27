/**
 * @workspace/agent-patterns
 *
 * Shared pattern libraries for agent development. These patterns provide
 * common functionality used across different agent implementations, reducing
 * boilerplate and ensuring consistent behavior.
 *
 * Patterns included:
 * - **queue**: Message queue with backpressure and flow control
 * - **settings**: Settings persistence with 3-way merge
 * - **trackers**: Typing/thinking/action indicator helpers (with lazy replyTo binding)
 * - **context**: Missed context accumulation for reconnect scenarios
 * - **context-usage**: Token/context window tracking across sessions
 * - **interrupt**: Pause/resume/abort controller for agent operations
 * - **tools**: Standard tool definitions (set_title, TodoWrite)
 * - **response**: Lazy message creation and checkpoint management
 *
 * @example
 * ```typescript
 * import {
 *   createMessageQueue,
 *   createSettingsManager,
 *   createTrackerManager,
 *   createMissedContextManager,
 *   createContextTracker,
 *   createInterruptController,
 *   createStandardTools,
 *   createResponseManager,
 * } from "@workspace/agent-patterns";
 *
 * // Use patterns in your agent
 * class MyAgent extends Agent<MyState> {
 *   private queue = createMessageQueue({
 *     onProcess: (event) => this.processMessage(event),
 *   });
 *
 *   private interrupt = createInterruptController();
 *
 *   async onEvent(event: EventStreamItem) {
 *     this.queue.enqueue(event);
 *   }
 *
 *   async onSleep() {
 *     this.queue.stop();
 *     await this.queue.drain();
 *   }
 * }
 * ```
 */

// Queue pattern - message processing with backpressure
export {
  createMessageQueue,
  type MessageQueueOptions,
  type MessageQueueStats,
  type MessageQueue,
} from "./queue/index.js";

// Settings pattern - settings persistence with 3-way merge
export {
  createSettingsManager,
  type SettingsManagerOptions,
  type SettingsManager,
} from "./settings/index.js";

// Tracker patterns - typing/thinking/action indicators
export {
  createTrackerManager,
  type TrackerManagerOptions,
  type TrackerManager,
} from "./trackers/index.js";

// Context pattern - missed context accumulation
export {
  createMissedContextManager,
  type MissedContextManagerOptions,
  type MissedContextManager,
} from "./context/index.js";

// Context usage pattern - token/context window tracking
export {
  createContextTracker,
  getModelContextLimit,
  MODEL_CONTEXT_LIMITS,
  type ContextTracker,
  type ContextTrackerOptions,
  type ContextTrackerState,
} from "./context-usage/index.js";

// Interrupt pattern - pause/resume/abort control
export {
  createInterruptController,
  type InterruptController,
  type InterruptControllerOptions,
} from "./interrupt/index.js";

// Tools pattern - standard tool definitions, registry, adapters
export {
  createStandardTools,
  createStandardMcpTools,
  executeStandardMcpTool,
  type StandardToolDefinition,
  type StandardToolsOptions,
  // PubsubToolRegistry
  buildPubsubToolRegistry,
  discoverPubsubTools,
  waitForTools,
  createToolExecutor,
  type PubsubTool,
  type PubsubToolRegistry,
  type BuildRegistryOptions,
  type DiscoverPubsubToolsOptions,
  // Tracking hooks
  createActionTrackingHooks,
  wrapWithTracking,
  type ToolTrackingHooks,
  // Approval handlers
  createCanUseToolGate,
  wrapWithApproval,
  type CanUseToolGateOptions,
  type WrapWithApprovalOptions,
  // SDK adapters
  toAiSdkTools,
  toPiCustomTools,
  toClaudeMcpTools,
  type AiSdkToolDefinition,
  type ToAiSdkToolsOptions,
  type PiToolDefinition,
  type ClaudeMcpToolsResult,
  type ClaudeMcpToolDef,
  type ToClaudeMcpToolsOptions,
} from "./tools/index.js";

// Panel helpers - panel lookup + method calls
export {
  findPanelParticipant,
  requirePanelParticipant,
  callPanelMethod,
  type PanelLookupOptions,
  type PanelMethodCallOptions,
} from "./panel/index.js";

// Response pattern - lazy message creation and checkpoints
export {
  createResponseManager,
  type ResponseManagerOptions,
  type ResponseManager,
} from "./response/index.js";

// System prompts
export {
  DEFAULT_CHAT_ASSISTANT_PERSONA,
  COMPONENT_ENHANCED_RICH_TEXT_GUIDE,
  createRichTextChatSystemPrompt,
} from "./prompts/index.js";
