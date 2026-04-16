/**
 * OpenAI Codex (ChatGPT) login flow — mobile.
 *
 * Mirrors the desktop `src/main/services/authService.ts` flow but uses
 * the OS browser + a custom-URL-scheme deep-link instead of a loopback
 * HTTP server. The deep-link handler in `oauthHandler.ts` resolves the
 * pending entry registered here.
 */

import { Linking } from "react-native";
import { openaiCodex, type AuthFlowCredentials } from "@natstack/auth-flow";
import { registerPendingFlow, dropPendingFlow } from "./authCallbackRegistry";

const REDIRECT_URI = "natstack://auth-callback";
const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

export async function runOpenaiCodexFlow(): Promise<AuthFlowCredentials> {
  const { authUrl, session } = await openaiCodex.buildAuthorizeUrl({ redirectUri: REDIRECT_URI });

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      dropPendingFlow(session.state);
      reject(new Error("OAuth flow timed out after 10 minutes"));
    }, FLOW_TIMEOUT_MS);

    registerPendingFlow(session.state, {
      timer,
      resolve: (params) => {
        clearTimeout(timer);
        if (params.state !== session.state) {
          reject(new Error("OAuth state mismatch"));
          return;
        }
        resolve(params.code);
      },
      reject: (err) => {
        clearTimeout(timer);
        reject(err);
      },
    });

    void Linking.openURL(authUrl).catch((err: unknown) => {
      dropPendingFlow(session.state);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  return openaiCodex.exchangeCode({
    code,
    verifier: session.verifier,
    redirectUri: session.redirectUri,
  });
}
