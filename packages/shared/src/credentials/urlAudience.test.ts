import { describe, expect, it } from "vitest";
import {
  credentialCarrierStripHeaders,
  findMatchingUrlAudience,
  normalizeCredentialInjection,
  normalizeUrlAudience,
  renderCredentialHeaderValue,
  urlMatchesAudience,
} from "./urlAudience.js";

describe("URL credential audiences", () => {
  it("normalizes origins and default ports", () => {
    expect(normalizeUrlAudience({
      url: "https://API.example.com:443/v1?x=1#frag",
      match: "origin",
    })).toEqual({
      url: "https://api.example.com/",
      match: "origin",
    });
  });

  it("matches path-prefix audiences on path segment boundaries", () => {
    const audience = normalizeUrlAudience({
      url: "https://api.example.com/v1/",
      match: "path-prefix",
    });

    expect(urlMatchesAudience("https://api.example.com/v1", audience)).toBe(true);
    expect(urlMatchesAudience("https://api.example.com/v1/models", audience)).toBe(true);
    expect(urlMatchesAudience("https://api.example.com/v10", audience)).toBe(false);
  });

  it("matches root path-prefix audiences across the whole origin", () => {
    const audience = normalizeUrlAudience({
      url: "https://api.example.com/",
      match: "path-prefix",
    });

    expect(urlMatchesAudience("https://api.example.com/", audience)).toBe(true);
    expect(urlMatchesAudience("https://api.example.com/v1/models", audience)).toBe(true);
    expect(urlMatchesAudience("https://other.example.com/v1/models", audience)).toBe(false);
  });

  it("keeps exact query strings exact and ordered", () => {
    const audience = normalizeUrlAudience({
      url: "https://api.example.com/search?a=1&a=2&b=3#ignored",
      match: "exact",
    });

    expect(urlMatchesAudience("https://api.example.com/search?a=1&a=2&b=3", audience)).toBe(true);
    expect(urlMatchesAudience("https://api.example.com/search?a=2&a=1&b=3", audience)).toBe(false);
    expect(urlMatchesAudience("https://api.example.com/search", {
      url: "https://api.example.com/search",
      match: "exact",
    })).toBe(true);
    expect(urlMatchesAudience("https://api.example.com/search?x=", {
      url: "https://api.example.com/search",
      match: "exact",
    })).toBe(false);
  });

  it("rejects unsafe audience URLs", () => {
    expect(() => normalizeUrlAudience({ url: "/relative", match: "origin" })).toThrow(/absolute/);
    expect(() => normalizeUrlAudience({ url: "https://user:pass@example.com/", match: "origin" })).toThrow(/username/);
    expect(() => normalizeUrlAudience({ url: "http://192.168.1.3/", match: "origin" })).toThrow(/HTTPS/);
    expect(() => normalizeUrlAudience({ url: "https://example.com./", match: "origin" })).toThrow(/trailing-dot/);
  });

  it("allows localhost and loopback HTTP for local development", () => {
    expect(normalizeUrlAudience({ url: "http://localhost:3000/callback", match: "origin" }).url).toBe(
      "http://localhost:3000/",
    );
    expect(normalizeUrlAudience({ url: "http://127.0.0.1:3000/callback", match: "path-prefix" }).url).toBe(
      "http://127.0.0.1:3000/callback",
    );
  });

  it("finds the first matching audience", () => {
    expect(findMatchingUrlAudience("https://api.example.com/v1/models", [
      { url: "https://other.example.com/", match: "origin" },
      { url: "https://api.example.com/v1", match: "path-prefix" },
    ])).toEqual({ url: "https://api.example.com/v1", match: "path-prefix" });
  });
});

describe("URL credential injection validation", () => {
  it("normalizes ordinary authorization header injection", () => {
    expect(normalizeCredentialInjection({
      type: "header",
      name: "Authorization",
      valueTemplate: "Bearer {token}",
      stripIncoming: ["X-API-Key", "authorization"],
    })).toEqual({
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}",
      stripIncoming: ["authorization", "x-api-key"],
    });
  });

  it("rejects unsafe headers and templates", () => {
    expect(() => normalizeCredentialInjection({
      type: "header",
      name: "cookie",
      valueTemplate: "{token}",
    })).toThrow(/cookie/);
    expect(() => normalizeCredentialInjection({
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token}\r\nX-Test: nope",
    })).toThrow(/control/);
    expect(() => normalizeCredentialInjection({
      type: "header",
      name: "authorization",
      valueTemplate: "Bearer {token} {token}",
    })).toThrow(/exactly one/);
  });

  it("renders and strips credential carriers safely", () => {
    expect(renderCredentialHeaderValue("Bearer {token}", "abc123")).toBe("Bearer abc123");
    expect(credentialCarrierStripHeaders({
      type: "header",
      name: "x-api-key",
      valueTemplate: "{token}",
      stripIncoming: ["x-custom-key"],
    }).sort()).toEqual(["authorization", "proxy-authorization", "x-api-key", "x-custom-key"]);
  });

  it("rejects unsafe query parameter names", () => {
    expect(() => normalizeCredentialInjection({ type: "query-param", name: "api_key" })).not.toThrow();
    expect(() => normalizeCredentialInjection({ type: "query-param", name: "api&key" })).toThrow(/Invalid/);
    expect(() => normalizeCredentialInjection({ type: "query-param", name: "../token" })).toThrow(/Invalid/);
  });
});
