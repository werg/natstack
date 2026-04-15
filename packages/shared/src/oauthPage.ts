/**
 * oauthPage — minimal success / error HTML shown in the browser at the end
 * of an OAuth redirect flow.
 *
 * Lives in shared rather than inside any single provider module because
 * every OAuth provider we own the callback for (currently just
 * `NatstackCodexProvider`; GitHub / Google / Anthropic are the likely next
 * additions) renders the same two pages. Keeping them here also means the
 * markup is version-tracked separately from any one provider's token-exchange
 * logic.
 *
 * pi-ai ships similar helpers at `@mariozechner/pi-ai/utils/oauth/oauth-page.js`
 * but doesn't export that subpath in `package.json#exports`, so we can't
 * import them without breaking our bundle. A self-contained reimplementation
 * is a dozen lines; the copy is worth it.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const BASE_STYLE =
  "body{font-family:system-ui,sans-serif;max-width:32em;margin:4em auto;padding:0 1em;color:#222}";

/** Success page — shown after a clean token exchange. */
export function oauthSuccessHtml(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<style>${BASE_STYLE}h1{color:#0a7a3b}</style>
<h1>✓ Signed in</h1><p>${escapeHtml(message)}</p>`;
}

/** Error page — shown when the callback is malformed or the flow failed. */
export function oauthErrorHtml(message: string, details?: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Sign-in failed</title>
<style>${BASE_STYLE}h1{color:#b00020}</style>
<h1>Sign-in failed</h1><p>${escapeHtml(message)}</p>${details ? `<p><em>${escapeHtml(details)}</em></p>` : ""}`;
}
