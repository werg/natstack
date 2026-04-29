import { describe, expect, it } from "vitest";

import { assertAllowedOAuthExternalUrl } from "./oauthExternal.js";

function authorizeUrl(overrides: Record<string, string> = {}): string {
  const url = new URL("https://auth.openai.com/oauth/authorize");
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", "client-1");
  url.searchParams.set("redirect_uri", "http://localhost:1455/auth/callback");
  url.searchParams.set("state", "state-1");
  url.searchParams.set("code_challenge", "challenge-1");
  url.searchParams.set("code_challenge_method", "S256");
  for (const [key, value] of Object.entries(overrides)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

describe("assertAllowedOAuthExternalUrl", () => {
  it("accepts a known OAuth authorize URL bound to the active loopback callback", () => {
    expect(() =>
      assertAllowedOAuthExternalUrl(
        authorizeUrl(),
        "http://localhost:1455/auth/callback",
      ),
    ).not.toThrow();
  });

  it("rejects arbitrary external sites", () => {
    expect(() =>
      assertAllowedOAuthExternalUrl(
        authorizeUrl({ redirect_uri: "http://localhost:1455/auth/callback" }).replace("auth.openai.com", "evil.example"),
        "http://localhost:1455/auth/callback",
      ),
    ).toThrow(/origin is not allowed/);
  });

  it("rejects redirect_uri mismatch", () => {
    expect(() =>
      assertAllowedOAuthExternalUrl(
        authorizeUrl({ redirect_uri: "http://localhost:1455/auth/callback" }),
        "http://localhost:1456/auth/callback",
      ),
    ).toThrow(/redirect_uri does not match/);
  });

  it("requires PKCE", () => {
    expect(() =>
      assertAllowedOAuthExternalUrl(
        authorizeUrl({ code_challenge_method: "plain" }),
        "http://localhost:1455/auth/callback",
      ),
    ).toThrow(/S256 PKCE/);
  });
});
