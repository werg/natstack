/**
 * Model catalog shared types.
 *
 * The workspace model-settings service returns the STATIC pi catalog described
 * here — no credentials, no connection state. Connection status is computed
 * panel-side from the panel's own `credentials.listStoredCredentials()` so it
 * stays scoped to that caller's identity.
 */

export const MODEL_SETTINGS_SERVICE_PROTOCOL = "natstack.models.v1";
export const WORKSPACE_DEFAULT_MODEL_FIELD = "defaultAgentModel";
export const DEFAULT_AGENT_MODEL_REF = "openai-codex:gpt-5.5";

/** Effort levels the agent harness accepts (subset of pi's ModelThinkingLevel). */
export type AgentThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface ModelCatalogProvider {
  id: string;
  label: string;
  /** Distinct base URLs across this provider's models (can be >1). */
  baseUrls: string[];
  /** Recommended onboarding/default model for this provider, when known. */
  recommendedModelRef: string | null;
  /**
   * Summary only: a connect preset exists AND at least one non-templated model
   * baseUrl. The per-model `connectable` flag is authoritative for the UI.
   */
  connectable: boolean;
}

export interface ModelCatalogEntry {
  /** Stable "provider:modelId" form used as the agent's `model` config. */
  ref: string;
  id: string;
  name: string;
  provider: string;
  /** Per-model base URL — used for credential matching. */
  baseUrl: string;
  reasoning: boolean;
  vision: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Model-supported subset of the four agent thinking levels. */
  thinkingLevels: AgentThinkingLevel[];
  /** baseUrl contains "{...}" placeholders → not quick-connectable. */
  templatedBaseUrl: boolean;
  /** Authoritative: a connect preset exists for the provider AND !templatedBaseUrl. */
  connectable: boolean;
  /** Part of the curated flagship-newest recommended set. */
  recommended: boolean;
}

export interface ModelCatalog {
  providers: ModelCatalogProvider[];
  models: ModelCatalogEntry[];
}

export interface ModelSettingsSnapshot {
  catalog: ModelCatalog;
  defaultModel: string;
  defaultModelSource: "workspace" | "fallback";
  invalidDefaultModel?: string;
}
