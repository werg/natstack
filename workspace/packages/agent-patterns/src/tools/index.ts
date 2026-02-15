/**
 * Tools pattern - common tool definitions and infrastructure for agents.
 */

// Standard tools (set_title, TodoWrite)
export {
  createStandardTools,
  createStandardMcpTools,
  executeStandardMcpTool,
  type StandardToolDefinition,
  type StandardToolsOptions,
} from "./standard-tools.js";

// PubsubToolRegistry - pure discovery
export {
  buildPubsubToolRegistry,
  discoverPubsubTools,
  discoverPubsubToolsForMode,
  waitForTools,
  createToolExecutor,
  type PubsubTool,
  type PubsubToolRegistry,
  type BuildRegistryOptions,
  type DiscoverPubsubToolsOptions,
  type DiscoverPubsubToolsForModeOptions,
  DEFAULT_UNRESTRICTED_PUBSUB_METHODS,
} from "./pubsub-tool-registry.js";

// Tracking hooks
export {
  createActionTrackingHooks,
  wrapWithTracking,
  type ToolTrackingHooks,
} from "./tracking.js";

// Approval handlers
export {
  createCanUseToolGate,
  wrapWithApproval,
  type CanUseToolGateOptions,
  type WrapWithApprovalOptions,
} from "./approval.js";

// SDK adapters
export {
  toAiSdkTools,
  toCodexMcpTools,
  toClaudeMcpTools,
  type AiSdkToolDefinition,
  type ToAiSdkToolsOptions,
  type CodexToolDefinition,
  type ToCodexMcpToolsOptions,
  type ClaudeMcpToolsResult,
  type ClaudeMcpToolDef,
  type ToClaudeMcpToolsOptions,
} from "./sdk-adapters/index.js";
