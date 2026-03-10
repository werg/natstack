/**
 * SDK Adapters - format converters for each SDK.
 */

export { toAiSdkTools, type AiSdkToolDefinition, type ToAiSdkToolsOptions } from "./ai-sdk.js";
export { toPiCustomTools, type PiToolDefinition } from "./pi.js";
export {
  toClaudeMcpTools,
  type ClaudeMcpToolsResult,
  type ClaudeMcpToolDef,
  type ToClaudeMcpToolsOptions,
} from "./claude.js";
