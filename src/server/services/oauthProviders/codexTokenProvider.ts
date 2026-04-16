/**
 * CodexTokenProvider — server-side token-side surface for OpenAI Codex.
 *
 * Implements only the parts of `OAuthProviderInterface` the server needs
 * after the auth refactor: `refreshToken` (silent refresh-token grant) and
 * `getApiKey`. The interactive `login` flow now lives in
 * `@natstack/auth-flow/providers/openaiCodex` and runs on the client.
 *
 * Both retained methods delegate to pi-ai's `openaiCodexOAuthProvider`,
 * which already handles refresh + key extraction correctly — those code
 * paths never touched a callback server.
 */

import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderInterface,
} from "@mariozechner/pi-ai";

type PiAiOauthModule = { openaiCodexOAuthProvider: OAuthProviderInterface };
let _piAiOauthPromise: Promise<PiAiOauthModule> | null = null;
function loadPiAiOauth(): Promise<PiAiOauthModule> {
  if (!_piAiOauthPromise) {
    _piAiOauthPromise = import("@mariozechner/pi-ai/oauth") as Promise<PiAiOauthModule>;
  }
  return _piAiOauthPromise;
}

export class CodexTokenProvider implements OAuthProviderInterface {
  readonly id = "openai-codex";
  readonly name = "ChatGPT Plus/Pro (Codex Subscription)";
  readonly usesCallbackServer = false;

  async login(_callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
    throw new Error(
      "openai-codex login runs on the client (Electron main / mobile shell), not the server. " +
      "Call authTokens.persist with the credentials produced by @natstack/auth-flow.",
    );
  }

  async refreshToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
    const mod = await loadPiAiOauth();
    return mod.openaiCodexOAuthProvider.refreshToken(credentials);
  }

  getApiKey(credentials: OAuthCredentials): string {
    return credentials.access;
  }
}
