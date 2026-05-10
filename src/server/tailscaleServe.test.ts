import { describe, expect, it } from "vitest";
import { classifyServeStatus } from "./tailscaleServe.js";

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
