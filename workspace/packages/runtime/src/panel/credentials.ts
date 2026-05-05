import type { RpcCaller } from "@natstack/rpc";
import { openExternal } from "./browser.js";
import { createLoopbackCallback } from "./oauth.js";
import {
  createCredentialClient,
  type BeginOAuthPkceCredentialResult,
  type BeginOAuthClientPkceCredentialRequest,
  type CompleteOAuthPkceCredentialRequest,
  type CreateOAuthPkceCredentialRequest,
  type CredentialClient,
  type GetOAuthClientConfigStatusRequest,
  type GitHttpClient,
  type GrantUrlBoundCredentialRequest,
  type OAuthClientConfigStatus,
  type RequestCredentialInputRequest,
  type RequestOAuthClientConfigRequest,
  type ResolveUrlBoundCredentialRequest,
  type StoredCredentialSummary,
  type StoreUrlBoundCredentialRequest,
} from "../shared/credentials.js";

export interface OAuthLoopbackOptions {
  host?: string;
  port?: number;
  callbackPath?: string;
}

export type OAuthAuthorizeOpenMode = "external" | "panel" | "manual";

export interface ConnectOAuthPkceCredentialRequest extends Omit<CreateOAuthPkceCredentialRequest, "redirectUri"> {
  loopback?: OAuthLoopbackOptions;
  openMode?: OAuthAuthorizeOpenMode;
}

export interface ConnectOAuthClientPkceCredentialRequest extends Omit<BeginOAuthClientPkceCredentialRequest, "redirectUri"> {
  loopback?: OAuthLoopbackOptions;
  openMode?: OAuthAuthorizeOpenMode;
}

let client: CredentialClient | null = null;

function requireClient(): CredentialClient {
  if (!client) {
    throw new Error("Panel credentials have not been initialized");
  }
  return client;
}

export function initPanelCredentials(rpc: RpcCaller): void {
  if (!client) {
    client = createCredentialClient(rpc);
  }
}

export async function store(input: StoreUrlBoundCredentialRequest): Promise<StoredCredentialSummary> {
  return requireClient().store(input);
}

export async function beginCreateWithOAuthPkce(
  input: CreateOAuthPkceCredentialRequest,
): Promise<BeginOAuthPkceCredentialResult> {
  return requireClient().beginCreateWithOAuthPkce(input);
}

export async function beginCreateWithOAuthClientPkce(
  input: BeginOAuthClientPkceCredentialRequest,
): Promise<BeginOAuthPkceCredentialResult> {
  return requireClient().beginCreateWithOAuthClientPkce(input);
}

export async function completeCreateWithOAuthPkce(
  input: CompleteOAuthPkceCredentialRequest,
): Promise<StoredCredentialSummary> {
  return requireClient().completeCreateWithOAuthPkce(input);
}

export async function connectWithOAuthPkce(
  input: ConnectOAuthPkceCredentialRequest,
): Promise<StoredCredentialSummary> {
  return runOAuthPkceCredentialFlow(
    input,
    (redirectUri) => requireClient().beginCreateWithOAuthPkce({ ...input, redirectUri }),
  );
}

export async function connectWithOAuthClientPkce(
  input: ConnectOAuthClientPkceCredentialRequest,
): Promise<StoredCredentialSummary> {
  return runOAuthPkceCredentialFlow(
    input,
    (redirectUri) => requireClient().beginCreateWithOAuthClientPkce({ ...input, redirectUri }),
  );
}

export async function requestOAuthClientConfig(
  input: RequestOAuthClientConfigRequest,
): Promise<OAuthClientConfigStatus> {
  return requireClient().requestOAuthClientConfig(input);
}

export async function requestCredentialInput(
  input: RequestCredentialInputRequest,
): Promise<StoredCredentialSummary> {
  return requireClient().requestCredentialInput(input);
}

export async function getOAuthClientConfigStatus(
  input: GetOAuthClientConfigStatusRequest,
): Promise<OAuthClientConfigStatus> {
  return requireClient().getOAuthClientConfigStatus(input);
}

export async function listStoredCredentials(): Promise<StoredCredentialSummary[]> {
  return requireClient().listStoredCredentials();
}

export async function revokeCredential(credentialId: string): Promise<void> {
  await requireClient().revokeCredential(credentialId);
}

export async function grantCredential(input: GrantUrlBoundCredentialRequest): Promise<StoredCredentialSummary> {
  return requireClient().grantCredential(input);
}

export async function resolveCredential(
  input: ResolveUrlBoundCredentialRequest,
): Promise<StoredCredentialSummary | null> {
  return requireClient().resolveCredential(input);
}

export async function fetch(
  url: string | URL,
  init?: RequestInit,
  opts?: { credentialId?: string },
): Promise<Response> {
  return requireClient().fetch(url, init, opts);
}

export function hookForUrl(
  url: string | URL,
  opts?: { credentialId?: string },
): (init?: RequestInit) => Promise<Response> {
  return requireClient().hookForUrl(url, opts);
}

export function gitHttp(opts?: { credentialId?: string }): GitHttpClient {
  return requireClient().gitHttp(opts);
}

async function runOAuthPkceCredentialFlow(
  input: { loopback?: OAuthLoopbackOptions; openMode?: OAuthAuthorizeOpenMode },
  begin: (redirectUri: string) => Promise<BeginOAuthPkceCredentialResult>,
): Promise<StoredCredentialSummary> {
  const callback = await createLoopbackCallback(input.loopback);
  try {
    const started = await begin(callback.redirectUri);
    await callback.expectState(started.state);
    await openOAuthAuthorizeUrl(started.authorizeUrl, callback.redirectUri, input.openMode ?? "external");
    const result = await callback.waitForCallback();
    return await requireClient().completeCreateWithOAuthPkce({
      nonce: started.nonce,
      code: result.code,
      state: result.state,
    });
  } finally {
    await callback.close().catch(() => {});
  }
}

async function openOAuthAuthorizeUrl(
  authorizeUrl: string,
  redirectUri: string,
  mode: OAuthAuthorizeOpenMode,
): Promise<void> {
  switch (mode) {
    case "external":
      await openExternal(authorizeUrl, { expectedRedirectUri: redirectUri });
      return;
    case "panel":
      window.open(authorizeUrl, "_blank", "noopener,noreferrer");
      return;
    case "manual":
      return;
    default:
      throw new Error(`Unsupported OAuth authorize open mode: ${String(mode)}`);
  }
}

export type {
  BeginOAuthPkceCredentialResult,
  BeginOAuthClientPkceCredentialRequest,
  CompleteOAuthPkceCredentialRequest,
  CreateOAuthPkceCredentialRequest,
  CredentialClient,
  GetOAuthClientConfigStatusRequest,
  GitHttpClient,
  GrantUrlBoundCredentialRequest,
  OAuthClientConfigStatus,
  RequestCredentialInputRequest,
  RequestOAuthClientConfigRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
} from "../shared/credentials.js";
