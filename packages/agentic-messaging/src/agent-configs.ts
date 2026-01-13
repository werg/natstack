/**
 * Centralized Agent Configuration Definitions
 *
 * Single source of truth for all agent parameters. Used by:
 * - Agent Manager to advertise agent capabilities
 * - Pre-connection UI (AgentSetupPhase) to render parameter inputs
 * - Workers to validate and merge initialization config
 * - Settings UI generator to create runtime settings forms
 */

import type { FieldDefinition, FieldValue } from "@natstack/runtime";

/**
 * Fallback model lists for when SDK is unavailable.
 * These are used as default options in parameter definitions.
 */
export const CLAUDE_MODEL_FALLBACKS: Array<{ value: string; label: string; description?: string }> = [
  { value: "claude-opus-4-5-20251101", label: "Claude Opus 4.5", description: "Most capable model" },
  { value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5", description: "Balanced performance" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", description: "Fast and efficient" },
  { value: "claude-opus-4-1-20250805", label: "Claude Opus 4.1" },
  { value: "claude-sonnet-4-20250514", label: "Claude Sonnet 4" },
  { value: "claude-opus-4-20250514", label: "Claude Opus 4" },
];

export const AI_ROLE_FALLBACKS: Array<{ value: string; label: string; description?: string }> = [
  { value: "fast", label: "Fast", description: "Quick responses, lower latency" },
  { value: "smart", label: "Smart", description: "More thoughtful, higher quality" },
  { value: "coding", label: "Coding", description: "Optimized for code generation" },
];

/**
 * Claude Code agent parameters
 */
export const CLAUDE_CODE_PARAMETERS: FieldDefinition[] = [
  {
    key: "workingDirectory",
    label: "Working Directory",
    description: "The directory where Claude Code will operate. Leave empty for workspace root.",
    type: "string",
    required: false,
    placeholder: "/path/to/project",
    group: "Environment",
    order: 0,
  },
  {
    key: "model",
    label: "Model",
    description: "Claude model for code generation",
    type: "select",
    required: false,
    default: "claude-sonnet-4-5-20250929",
    // Fallback options - workers may override with dynamic SDK list at runtime
    options: CLAUDE_MODEL_FALLBACKS,
    group: "Model",
    order: 1,
  },
  {
    key: "maxThinkingTokens",
    label: "Thinking Budget",
    description: "Extended thinking token budget for complex reasoning",
    type: "slider",
    required: false,
    default: 10240,
    min: 0,
    max: 32000,
    step: 1024,
    sliderLabels: { min: "Off", max: "Maximum" },
    group: "Model",
    order: 2,
  },
  {
    key: "executionMode",
    label: "Execution Mode",
    type: "toggle",
    default: "edit",
    options: [
      { value: "plan", label: "Plan", description: "Explore and plan without executing tools" },
      { value: "edit", label: "Edit", description: "Execute tools to make changes" },
    ],
    group: "Permissions",
    order: 3,
  },
  {
    key: "autonomyLevel",
    label: "Autonomy",
    type: "slider",
    default: 0,
    min: 0,
    max: 2,
    step: 1,
    notches: [
      { value: 0, label: "Ask", description: "Ask before each tool use" },
      { value: 1, label: "Auto-edits", description: "Auto-approve file edits, ask for others" },
      { value: 2, label: "Full Auto", description: "Skip all permission prompts" },
    ],
    visibleWhen: { field: "executionMode", operator: "eq", value: "edit" },
    warnings: [{ when: 2, message: "Allows unrestricted tool execution", severity: "danger" }],
    group: "Permissions",
    order: 4,
  },
];

/**
 * AI Responder (fast AI) agent parameters
 */
export const AI_RESPONDER_PARAMETERS: FieldDefinition[] = [
  {
    key: "modelRole",
    label: "Model Role",
    description: "Optimized model configuration for different tasks",
    type: "select",
    required: false,
    default: "fast",
    // Fallback options - workers may override with dynamic ai.listRoles() at runtime
    options: AI_ROLE_FALLBACKS,
    group: "Model",
    order: 0,
  },
  {
    key: "temperature",
    label: "Temperature",
    description: "Controls randomness in responses",
    type: "slider",
    required: false,
    default: 0.7,
    min: 0,
    max: 2,
    step: 0.1,
    sliderLabels: { min: "Precise", max: "Creative" },
    group: "Model",
    order: 1,
  },
  {
    key: "maxOutputTokens",
    label: "Response Length",
    description: "Maximum tokens in generated responses",
    type: "slider",
    required: false,
    default: 1024,
    min: 256,
    max: 4096,
    step: 256,
    sliderLabels: { min: "Brief", max: "Detailed" },
    group: "Model",
    order: 2,
  },
  {
    key: "approvalLevel",
    label: "Tool Approval",
    type: "slider",
    default: 0,
    min: 0,
    max: 2,
    step: 1,
    notches: [
      { value: 0, label: "Ask", description: "Ask before each tool use" },
      { value: 1, label: "Auto Safe", description: "Auto-approve read-only tools" },
      { value: 2, label: "Full Auto", description: "Execute all tools automatically" },
    ],
    warnings: [{ when: 2, message: "Allows unrestricted tool execution", severity: "warning" }],
    group: "Permissions",
    order: 3,
  },
  {
    key: "maxSteps",
    label: "Max Agent Steps",
    type: "slider",
    default: 5,
    min: 1,
    max: 20,
    step: 1,
    sliderLabels: { min: "1", max: "20" },
    group: "Capabilities",
    order: 4,
  },
];

/**
 * Codex agent parameters
 */
export const CODEX_PARAMETERS: FieldDefinition[] = [
  {
    key: "workingDirectory",
    label: "Working Directory",
    description: "The directory where Codex will operate. Leave empty for workspace root.",
    type: "string",
    required: false,
    placeholder: "/path/to/project",
    group: "Environment",
    order: 0,
  },
  {
    key: "model",
    label: "Model",
    description: "OpenAI Codex model for code generation",
    type: "select",
    required: false,
    default: "gpt-5.2-codex",
    options: [
      { value: "gpt-5.2-codex", label: "GPT-5.2 Codex", description: "Most advanced agentic coding model" },
      { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max", description: "Long-horizon agentic coding" },
      { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini", description: "Cost-effective coding" },
      { value: "gpt-5.2", label: "GPT-5.2", description: "Best general agentic model" },
      { value: "gpt-5.1", label: "GPT-5.1", description: "Previous generation" },
      { value: "gpt-5.1-codex", label: "GPT-5.1 Codex", description: "Previous Codex model" },
    ],
    group: "Model",
    order: 1,
  },
  {
    key: "reasoningEffort",
    label: "Reasoning Effort",
    description: "Higher effort = more thorough but slower",
    type: "slider",
    required: false,
    default: 2, // medium
    min: 0,
    max: 3,
    step: 1,
    notches: [
      { value: 0, label: "Minimal", description: "Fast, minimal reasoning" },
      { value: 1, label: "Low", description: "Quick reasoning" },
      { value: 2, label: "Medium", description: "Balanced approach" },
      { value: 3, label: "High", description: "Thorough, slower" },
    ],
    group: "Model",
    order: 2,
  },
  {
    key: "sandboxMode",
    label: "File Access",
    type: "slider",
    required: false,
    default: 1, // workspace-write
    min: 0,
    max: 2,
    step: 1,
    notches: [
      { value: 0, label: "Read Only", description: "Read-only access, network blocked" },
      { value: 1, label: "Workspace", description: "Can modify files in the workspace" },
      { value: 2, label: "Full Access", description: "Unrestricted file and network access" },
    ],
    warnings: [{ when: 2, message: "Allows unrestricted file system access", severity: "danger" }],
    group: "Permissions",
    order: 3,
  },
  {
    key: "networkAccessEnabled",
    label: "Network Access",
    description: "Allow outbound network requests",
    type: "boolean",
    required: false,
    default: false,
    // Only configurable in workspace mode - read-only blocks network, full-access enables it
    visibleWhen: { field: "sandboxMode", operator: "eq", value: 1 },
    group: "Permissions",
    order: 4,
  },
  {
    key: "webSearchEnabled",
    label: "Web Search",
    description: "Allow web search capabilities",
    type: "boolean",
    required: false,
    default: false,
    group: "Permissions",
    order: 5,
  },
];

/**
 * Get default values from parameter definitions
 */
export function getParameterDefaults(
  parameters: FieldDefinition[]
): Record<string, FieldValue> {
  const defaults: Record<string, FieldValue> = {};
  for (const param of parameters) {
    if (param.default !== undefined) {
      defaults[param.key] = param.default;
    }
  }
  return defaults;
}
