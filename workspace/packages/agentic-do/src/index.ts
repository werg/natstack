/**
 * @workspace/agentic-do — Composable agent modules for Durable Objects.
 *
 * Agent DOs extend AgentWorkerBase, which embeds Pi (`@earendil-works/pi-agent-core`)
 * in-process via the PiRunner from `@workspace/harness`. Non-agent DOs (e.g.
 * PubSub channel DOs) extend DurableObjectBase directly.
 */

export { AgentWorkerBase } from "./agent-worker-base.js";
export type { ModelCredentialSetupProps, ModelCredentialSummary } from "./agent-worker-base.js";
export {
  DEFAULT_APPROVAL_LEVEL,
  DEFAULT_MODEL,
  DEFAULT_RESPOND_POLICY,
  DEFAULT_THINKING_LEVEL,
  OPENAI_CODEX_ACCOUNT_CLAIM,
  PROVIDER_CREDENTIAL_SETUPS,
} from "./agent-config.js";
export { TrajectoryVesselBase } from "./trajectory-vessel-base.js";
export type { CustomMessageReducer, RespondPolicy } from "./trajectory-vessel-base.js";
export { DOIdentity } from "./identity.js";
export { SubscriptionManager } from "./subscription-manager.js";
export { ChannelClient } from "./channel-client.js";
export {
  CardManager,
  CardTypeNotRegisteredError,
  CardValidationError,
} from "./custom-cards.js";
export type { CustomMessageHandle } from "./custom-cards.js";
export { FeedbackIngest, formatFeedbackNote } from "./feedback-ingest.js";
// Registration-time renderer lint (re-exported so agent workers don't need a
// direct agentic-core dependency just for this).
export { DEFAULT_HOST_MODULES, lintRendererSource } from "@workspace/agentic-core";
export type { RendererLintIssue } from "@workspace/agentic-core";
