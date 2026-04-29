/**
 * Mobile credential consent service.
 *
 * Opens the provider authorize URL in the OS browser, waits for the app's
 * universal-link/custom-scheme callback, then exchanges the authorization code
 * with the server over the existing mobile RPC transport.
 */

import { Linking } from "react-native";
import type { MobileTransport } from "./mobileTransport";

const FLOW_TIMEOUT_MS = 10 * 60 * 1000;

export interface LaunchConsentFlowParams {
  authorizeUrl: string;
  callbackUrl: string;
  providerId: string;
}

export interface CompleteConsentParams {
  providerId?: string;
  nonce: string;
  code: string;
  state: string;
}

export interface ConsentCallbackParams {
  code: string;
  state: string;
}

export interface CompleteConsentResult {
  connectionId: string;
  apiBase: string[];
}

interface PendingConsentFlow {
  callbackUrl: string;
  providerId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve: (params: ConsentCallbackParams | null) => void;
  reject: (error: Error) => void;
}

const pendingFlows = new Map<string, PendingConsentFlow>();

let configuredTransport: Pick<MobileTransport, "call"> | null = null;

export function setCredentialConsentTransport(
  transport: Pick<MobileTransport, "call"> | null,
): void {
  configuredTransport = transport;
}

export async function launchConsentFlow(
  params: LaunchConsentFlowParams,
): Promise<ConsentCallbackParams | null> {
  const authorizeUrl = parseUrl(params.authorizeUrl, "authorizeUrl");
  const callbackUrl = parseUrl(params.callbackUrl, "callbackUrl");
  const state = authorizeUrl.searchParams.get("state");

  if (!state) {
    throw new Error(`Consent authorize URL for ${params.providerId} is missing a state parameter`);
  }

  const existing = pendingFlows.get(state);
  if (existing) {
    clearTimeout(existing.timer);
    existing.reject(new Error(`Consent flow for state ${state} was replaced by a new request`));
    pendingFlows.delete(state);
  }

  return new Promise<ConsentCallbackParams | null>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingFlows.delete(state);
      resolve(null);
    }, FLOW_TIMEOUT_MS);

    pendingFlows.set(state, {
      callbackUrl: callbackUrl.toString(),
      providerId: params.providerId,
      timer,
      resolve: (result) => {
        clearTimeout(timer);
        resolve(result);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });

    void Linking.openURL(authorizeUrl.toString()).catch((error: unknown) => {
      pendingFlows.delete(state);
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

export function handleUniversalLink(url: string): ConsentCallbackParams | null {
  let callback: URL;
  try {
    callback = new URL(url);
  } catch {
    return null;
  }

  const code = callback.searchParams.get("code");
  const state = callback.searchParams.get("state");

  if (!code || !state) {
    return null;
  }

  const pending = pendingFlows.get(state);
  if (!pending) {
    return null;
  }

  if (!matchesCallbackUrl(pending.callbackUrl, callback)) {
    return null;
  }

  pendingFlows.delete(state);
  const params = { code, state };
  pending.resolve(params);
  return params;
}

export async function completeConsent(
  params: CompleteConsentParams,
): Promise<CompleteConsentResult> {
  const transport = getCredentialConsentTransport();
  return transport.call<CompleteConsentResult>(
    "main",
    "credentials.completeConsent",
    params,
  );
}

function getCredentialConsentTransport(): Pick<MobileTransport, "call"> {
  if (configuredTransport) {
    return configuredTransport;
  }

  throw new Error("Credential consent transport is not available");
}

function parseUrl(raw: string, label: string): URL {
  try {
    return new URL(raw);
  } catch {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
}

function matchesCallbackUrl(expectedRaw: string, actual: URL): boolean {
  const expected = parseUrl(expectedRaw, "callbackUrl");
  return expected.protocol === actual.protocol &&
    expected.host === actual.host &&
    normalizePathname(expected.pathname) === normalizePathname(actual.pathname);
}

function normalizePathname(pathname: string): string {
  return pathname.endsWith("/") && pathname !== "/" ? pathname.slice(0, -1) : pathname;
}
