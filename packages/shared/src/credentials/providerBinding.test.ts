import { describe, expect, it } from "vitest";
import type { ProviderManifest } from "./types.js";
import {
  createProviderBinding,
  normalizeApiBase,
  normalizeUrlPrefix,
} from "./providerBinding.js";

function manifest(overrides: Partial<ProviderManifest> = {}): ProviderManifest {
  return {
    id: "github",
    displayName: "GitHub",
    apiBase: ["https://api.github.com/"],
    flows: [],
    authInjection: {
      type: "header",
      headerName: "Authorization",
      valueTemplate: "Bearer {token}",
      stripHeaders: ["Authorization"],
    },
    ...overrides,
  };
}

describe("provider binding", () => {
  it("is independent of userland namespace and display text", () => {
    const left = createProviderBinding(manifest({ id: "github", displayName: "GitHub" }));
    const right = createProviderBinding(manifest({ id: "octokit", displayName: "Octokit" }));

    expect(left.fingerprint).toBe(right.fingerprint);
  });

  it("changes when the audience changes", () => {
    const left = createProviderBinding(manifest({ apiBase: ["https://api.github.com/"] }));
    const right = createProviderBinding(manifest({ apiBase: ["https://attacker.example/"] }));

    expect(left.fingerprint).not.toBe(right.fingerprint);
  });

  it("changes when the injection channel changes", () => {
    const left = createProviderBinding(manifest({
      authInjection: { type: "header", headerName: "Authorization", valueTemplate: "Bearer {token}" },
    }));
    const right = createProviderBinding(manifest({
      authInjection: { type: "query-param", paramName: "access_token" },
    }));

    expect(left.fingerprint).not.toBe(right.fingerprint);
  });

  it("does not depend on OAuth or other userland acquisition flows", () => {
    const left = createProviderBinding(manifest({
      flows: [{ type: "loopback-pkce", clientId: "a", authorizeUrl: "https://auth.example/a", tokenUrl: "https://auth.example/token" }],
    }));
    const right = createProviderBinding(manifest({
      flows: [{ type: "loopback-pkce", clientId: "b", authorizeUrl: "https://auth.example/b", tokenUrl: "https://auth.example/token" }],
    }));

    expect(left.fingerprint).toBe(right.fingerprint);
  });

  it("normalizes URL prefixes deterministically", () => {
    expect(normalizeApiBase([
      "https://API.GITHUB.com:443/repos/",
      "https://api.github.com/repos",
    ])).toEqual(["https://api.github.com/repos"]);
  });

  it("normalizes unreserved path encoding without decoding reserved delimiters", () => {
    expect(normalizeUrlPrefix("https://example.com/%7Euser/%2Fsecret/")).toBe(
      "https://example.com/~user/%2Fsecret",
    );
  });

  it("keeps explicit non-default ports in the audience", () => {
    expect(normalizeUrlPrefix("https://example.com:8443/v1/")).toBe("https://example.com:8443/v1");
  });
});
