import { describe, expect, it } from "vitest";
import { classifyServeError, classifyServeStatus } from "./tailscaleServe.js";

describe("classifyServeStatus", () => {
  it("treats empty status as empty", () => {
    expect(classifyServeStatus({}, { port: 3030, hostname: "host.tailnet.ts.net" }))
      .toBe("empty");
  });

  it("matches when a Web handler proxies to the same port via 127.0.0.1", () => {
    const status = {
      Web: {
        "host.tailnet.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3030" } },
        },
      },
    };
    expect(classifyServeStatus(status, { port: 3030, hostname: "host.tailnet.ts.net" }))
      .toBe("matches");
  });

  it("matches when proxy uses localhost instead of 127.0.0.1", () => {
    const status = {
      Web: {
        "host.tailnet.ts.net:443": {
          Handlers: { "/": { Proxy: "http://localhost:3030" } },
        },
      },
    };
    expect(classifyServeStatus(status, { port: 3030, hostname: "host.tailnet.ts.net" }))
      .toBe("matches");
  });

  it("treats a handler pointing to a different port as a conflict", () => {
    const status = {
      Web: {
        "host.tailnet.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:8080" } },
        },
      },
    };
    expect(classifyServeStatus(status, { port: 3030, hostname: "host.tailnet.ts.net" }))
      .toBe("conflict");
  });

  it("matches under the legacy Services key as well as Web", () => {
    const status = {
      Services: {
        "host.tailnet.ts.net:443": {
          Handlers: { "/": { Proxy: "http://127.0.0.1:3030" } },
        },
      },
    };
    expect(classifyServeStatus(status, { port: 3030, hostname: "host.tailnet.ts.net" }))
      .toBe("matches");
  });

  it("considers a static-content handler (no Proxy) a conflict", () => {
    const status = {
      Web: {
        "host.tailnet.ts.net:443": {
          Handlers: { "/": { Path: "/var/www/html" } },
        },
      },
    };
    expect(classifyServeStatus(status, { port: 3030, hostname: "host.tailnet.ts.net" }))
      .toBe("conflict");
  });
});

describe("classifyServeError", () => {
  it("recognizes the 'Serve is not enabled' daemon message and extracts the activation URL", () => {
    const stderr =
      "\nServe is not enabled on your tailnet.\nTo enable, visit:\n\n         https://login.tailscale.com/f/serve?node=nJ2kStdBXV11CNTRL\n\n";
    const result = classifyServeError(stderr, 1);
    expect(result.kind).toBe("serve-feature-disabled");
    if (result.kind !== "serve-feature-disabled") throw new Error("unreachable");
    expect(result.activationUrl).toBe("https://login.tailscale.com/f/serve?node=nJ2kStdBXV11CNTRL");
    expect(result.hint).toContain(result.activationUrl!);
  });

  it("falls back to a generic hint when the activation URL is missing", () => {
    const result = classifyServeError("Serve is not enabled on your tailnet.", 1);
    expect(result.kind).toBe("serve-feature-disabled");
    if (result.kind !== "serve-feature-disabled") throw new Error("unreachable");
    expect(result.activationUrl).toBeUndefined();
  });

  it("classifies permission errors as permission-denied", () => {
    const result = classifyServeError("tailscale: operation not permitted", 1);
    expect(result.kind).toBe("permission-denied");
  });

  it("classifies the older HTTPS-disabled message as https-feature-disabled", () => {
    const result = classifyServeError("HTTPS is disabled on this tailnet", 1);
    expect(result.kind).toBe("https-feature-disabled");
  });

  it("falls through to generic error for unrecognized stderr", () => {
    const result = classifyServeError("something unexpected went wrong", 1);
    expect(result.kind).toBe("error");
  });
});
