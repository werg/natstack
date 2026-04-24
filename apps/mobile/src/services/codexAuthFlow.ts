/**
 * OpenAI Codex (ChatGPT) login flow — mobile.
 *
 * Uses the server-prepared authorize URL, then waits for the browser to
 * return a custom-URL-scheme deep link containing the authorization code.
 */

import { Linking } from "react-native";
import { registerPendingFlow, dropPendingFlow } from "./authCallbackRegistry";

const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

export async function runOpenaiCodexFlow(authorizeUrl: string, expectedState: string): Promise<string> {
  const authUrl = new URL(authorizeUrl);
  const state = authUrl.searchParams.get("state");
  if (!state || state !== expectedState) {
    throw new Error("OAuth state mismatch");
  }

  const code = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      dropPendingFlow(expectedState);
      reject(new Error("OAuth flow timed out after 10 minutes"));
    }, FLOW_TIMEOUT_MS);

    registerPendingFlow(expectedState, {
      timer,
      resolve: (params) => {
        clearTimeout(timer);
        if (params.state !== expectedState) {
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

    void Linking.openURL(authUrl.toString()).catch((err: unknown) => {
      dropPendingFlow(expectedState);
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  return code;
}
