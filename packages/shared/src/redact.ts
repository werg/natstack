/**
 * Token / secret redaction helpers.
 *
 * Mirrors the style of src/server/services/secretsService.ts:22-25 so mask
 * output is consistent across the codebase. Keep this file dependency-free
 * so logger wrappers can import it cheaply.
 */

/**
 * Mask a token to its first 4 and last 4 chars, collapsing the middle to "…".
 * Short tokens (≤8 chars) become a single ellipsis so nothing meaningful leaks.
 */
export function redactToken(token: string | undefined | null): string {
  if (!token) return "(none)";
  if (token.length <= 8) return "…";
  return `${token.slice(0, 4)}…${token.slice(-4)}`;
}

/**
 * Redact occurrences of `token` inside arbitrary text (log lines, stack traces).
 * If the token appears literally, replace it with the masked form.
 */
export function redactTokenIn(text: string, token: string | undefined | null): string {
  if (!token || token.length <= 8) return text;
  if (!text.includes(token)) return text;
  return text.split(token).join(redactToken(token));
}
