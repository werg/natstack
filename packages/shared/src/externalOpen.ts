export interface OpenExternalOptions {
  expectedRedirectUri?: string;
}

export function assertAllowedOAuthExternalUrl(
  rawUrl: string,
  expectedRedirectUri: string,
): void {
  let url: URL;
  let redirectUri: URL;
  try {
    url = new URL(rawUrl);
    redirectUri = new URL(expectedRedirectUri);
  } catch {
    throw new Error("Invalid OAuth authorization URL");
  }

  if (url.protocol !== "https:") {
    throw new Error("OAuth authorization URL must use https");
  }
  if (url.searchParams.get("response_type") !== "code") {
    throw new Error("OAuth authorization URL must request an authorization code");
  }
  if (!url.searchParams.get("client_id")) {
    throw new Error("OAuth authorization URL is missing client_id");
  }
  if (!url.searchParams.get("state")) {
    throw new Error("OAuth authorization URL is missing state");
  }
  if (!url.searchParams.get("code_challenge")) {
    throw new Error("OAuth authorization URL is missing PKCE challenge");
  }
  if (url.searchParams.get("code_challenge_method") !== "S256") {
    throw new Error("OAuth authorization URL must use S256 PKCE");
  }
  if (url.searchParams.get("redirect_uri") !== expectedRedirectUri) {
    throw new Error("OAuth authorization redirect_uri does not match the active callback");
  }
  if (redirectUri.protocol !== "http:") {
    throw new Error("OAuth callback must use local http loopback");
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(redirectUri.hostname)) {
    throw new Error("OAuth callback must use local loopback");
  }
}
