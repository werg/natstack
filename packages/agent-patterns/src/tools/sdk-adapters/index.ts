/**
 * SDK Adapters - format converters for each SDK.
 */

export { toAiSdkTools, type AiSdkToolDefinition, type ToAiSdkToolsOptions } from "./ai-sdk.js";
export { toCodexMcpTools, type CodexToolDefinition, type ToCodexMcpToolsOptions } from "./codex.js";
export {
  toClaudeMcpTools,
  type ClaudeMcpToolsResult,
  type ClaudeMcpToolDef,
  type ToClaudeMcpToolsOptions,
} from "./claude.js";
