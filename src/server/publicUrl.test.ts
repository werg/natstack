import { afterEach, describe, expect, it } from "vitest";
import {
  buildPublicUrl,
  configurePublicUrl,
  getPublicBasePath,
  getPublicUrl,
  resetPublicUrl,
} from "./publicUrl.js";

describe("publicUrl", () => {
  afterEach(() => {
    resetPublicUrl();
  });

  it("derives the public base path from an explicit public URL override", () => {
    configurePublicUrl({
      override: "https://example.test/base/w/alpha",
      protocol: "http",
      externalHost: "localhost",
      gatewayPort: 3030,
    });

    expect(getPublicUrl()).toBe("https://example.test/base/w/alpha");
    expect(getPublicBasePath()).toBe("/base/w/alpha");
    expect(buildPublicUrl("/_r/s/credentials/oauth/callback")).toBe(
      "https://example.test/base/w/alpha/_r/s/credentials/oauth/callback"
    );
  });

  it("lets an explicit public base path override the URL path", () => {
    configurePublicUrl({
      override: "https://example.test/from-url",
      publicBasePath: "/from-env",
      protocol: "http",
      externalHost: "localhost",
      gatewayPort: 3030,
    });

    expect(getPublicBasePath()).toBe("/from-env");
  });
});
