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
  waitForTools,
  createToolExecutor,
  type PubsubTool,
  type PubsubToolRegistry,
  type BuildRegistryOptions,
  type DiscoverPubsubToolsOptions,
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
  toPiCustomTools,
  toClaudeMcpTools,
  type AiSdkToolDefinition,
  type ToAiSdkToolsOptions,
  type PiToolDefinition,
  type ClaudeMcpToolsResult,
  type ClaudeMcpToolDef,
  type ToClaudeMcpToolsOptions,
} from "./sdk-adapters/index.js";
