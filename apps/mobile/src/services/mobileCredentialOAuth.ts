/**
 * Mobile URL-bound credential OAuth helper.
 *
 * Userland calls the host-owned credential OAuth transaction. The server owns
 * browser handoff and callback validation; mobile only forwards browser-open
 * events through the shell bridge.
 */

import { Linking } from "react-native";
import type {
  ConnectCredentialRequest,
  StoredCredentialSummary,
} from "@natstack/shared/credentials/types";
import { registerPendingFlow, dropPendingFlow } from "./authCallbackRegistry";
import type { ShellClient } from "./shellClient";

const DEFAULT_CALLBACK_ORIGIN = "https://auth.snugenv.com";
const CALLBACK_PATH_PREFIX = "/oauth/callback";
const DEFAULT_FLOW_TIMEOUT_MS = 10 * 60 * 1000;

export interface ConnectMobileOAuthCredentialRequest
  extends ConnectCredentialRequest {
  providerId: string;
  redirectUri?: string;
  callbackOrigin?: string;
  timeoutMs?: number;
}

export function buildMobileOAuthRedirectUri(
  providerId: string,
  callbackOrigin = DEFAULT_CALLBACK_ORIGIN,
): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@+=:-]{0,127}$/.test(providerId)) {
    throw new Error("Invalid OAuth provider id");
  }
  const origin = callbackOrigin.endsWith("/")
    ? callbackOrigin.slice(0, -1)
    : callbackOrigin;
  return `${origin}${CALLBACK_PATH_PREFIX}/${encodeURIComponent(providerId)}`;
}

export async function connectMobileOAuthCredential(
  shellClient: ShellClient,
  request: ConnectMobileOAuthCredentialRequest,
): Promise<StoredCredentialSummary> {
  const redirectUri = request.redirectUri
    ?? buildMobileOAuthRedirectUri(request.providerId, request.callbackOrigin);
  return shellClient.transport.call<StoredCredentialSummary>(
    "main",
    "credentials.connect",
    {
      flow: request.flow,
      credential: request.credential,
      redirect: {
        ...(request.redirect ?? {}),
        type: "client-forwarded",
        callbackUri: redirectUri,
      },
      browser: request.browser ?? "external",
    },
  );
}

export async function waitForMobileOAuthCode(
  authorizeUrl: string,
  expectedState: string,
  timeoutMs = DEFAULT_FLOW_TIMEOUT_MS,
): Promise<string> {
  const authUrl = new URL(authorizeUrl);
  const state = authUrl.searchParams.get("state");
  if (!state || state !== expectedState) {
    throw new Error("OAuth state mismatch");
  }

  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      dropPendingFlow(expectedState);
      reject(new Error("OAuth flow timed out after 10 minutes"));
    }, timeoutMs);

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
}
