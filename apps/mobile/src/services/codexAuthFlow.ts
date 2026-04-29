/**
 * OpenAI Codex (ChatGPT) login flow — mobile.
 *
 * Uses the server-prepared authorize URL, then waits for the browser to
 * return a custom-URL-scheme deep link containing the authorization code.
 */

import { waitForMobileOAuthCode } from "./mobileCredentialOAuth";

export async function runOpenaiCodexFlow(authorizeUrl: string, expectedState: string): Promise<string> {
  return waitForMobileOAuthCode(authorizeUrl, expectedState);
}
