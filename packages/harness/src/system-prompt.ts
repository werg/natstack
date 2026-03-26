/**
 * System prompt construction for SDK adapters.
 *
 * Resolves the custom prompt text from HarnessConfig. Callers decide how to
 * pass the result to their SDK (append vs replace) based on
 * `config.systemPromptMode`.
 */

import type { HarnessConfig } from './types.js';

/**
 * Resolve the custom system prompt text from harness config.
 *
 * @returns The prompt string, or `undefined` when nothing was configured
 *   (SDK defaults are sufficient in append mode).
 */
export function buildSystemPrompt(config: HarnessConfig): string | undefined {
  return config.systemPrompt;
}

/**
 * Prepend a context note (e.g. missed messages, recovery context) to a prompt.
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
