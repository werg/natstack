/**
 * System prompt construction for Claude SDK adapter.
 *
 * Builds the system prompt from HarnessConfig and optional persona text.
 * Accepts a pre-built systemPrompt string via HarnessConfig and applies
 * lightweight wrappers here (e.g. appending context notes).
 */

import type { HarnessConfig, HarnessSettings } from './types.js';

/**
 * Build the final system prompt string for a Claude SDK query.
 *
 * Priority (highest to lowest):
 * 1. Per-turn `settings.systemPrompt` override
 * 2. `config.systemPrompt` from harness spawn config
 * 3. Fallback default persona
 *
 * @param config - The harness-level configuration
 * @param settings - Per-turn settings that may override the prompt
 * @returns The system prompt string to pass to the SDK
 */
export function buildSystemPrompt(
  config: HarnessConfig,
  settings?: HarnessSettings,
): string {
  // Per-turn override takes highest priority
  if (settings?.systemPrompt) {
    return settings.systemPrompt;
  }
  // Harness-level config
  if (config.systemPrompt) {
    return config.systemPrompt;
  }
  // Minimal fallback — callers should almost always provide a prompt
  return 'You are a helpful assistant.';
}

/**
 * Append a context note (e.g. missed messages, recovery context) to a prompt.
 *
 * @param prompt - The user's message text
 * @param contextNote - Additional context to prepend (may be undefined)
 * @returns The prompt with context prepended, or the original prompt
 */
export function prependContextNote(
  prompt: string,
  contextNote: string | undefined,
): string {
  if (!contextNote) return prompt;
  return `${contextNote}\n\n${prompt}`;
}
