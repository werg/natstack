import { describe, expect, it } from "vitest";
import { createConnectDeepLink, isTrustedCleartextHost, parseConnectLink } from "./connect";

describe("connect deep links", () => {
  it("round-trips a pairing link", () => {
    const link = createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24));
    expect(parseConnectLink(link)).toEqual({
      kind: "ok",
      url: "https://host.tailnet.ts.net",
      code: "A".repeat(24),
    });
  });

  it("rejects public cleartext HTTP", () => {
    expect(parseConnectLink(createConnectDeepLink("http://example.com", "A".repeat(24)))).toEqual({
      kind: "error",
      reason:
        "Cleartext HTTP is only allowed for loopback, private LAN, Tailscale, or local hostnames. Use https:// for example.com.",
    });
  });

  it("accepts local cleartext hosts", () => {
    expect(isTrustedCleartextHost("localhost")).toBe(true);
    expect(isTrustedCleartextHost("192.168.1.20")).toBe(true);
    expect(isTrustedCleartextHost("100.64.1.20")).toBe(true);
    expect(isTrustedCleartextHost("box.local")).toBe(true);
  });

  it("rejects malformed codes", () => {
    expect(parseConnectLink(createConnectDeepLink("https://host.tailnet.ts.net", "short"))).toEqual(
      {
        kind: "error",
        reason: "Pairing code has an unexpected format",
      }
    );
  });

  it("stays in parity with the plain Node script helpers", async () => {
    const scriptUrl = new URL("../../../scripts/connect-utils.mjs", import.meta.url);
    const script = (await import(scriptUrl.href)) as {
      createConnectDeepLink: (url: string, code: string) => string;
      parseConnectLink: (raw: string) => unknown;
    };
    const fixtures = [
      createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24)),
      createConnectDeepLink("http://127.0.0.1:3030", "B".repeat(24)),
      createConnectDeepLink("http://example.com", "C".repeat(24)),
      "not-a-link",
      createConnectDeepLink("https://host.tailnet.ts.net", "short"),
    ];

    expect(script.createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24))).toBe(
      createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24))
    );
    for (const fixture of fixtures) {
      expect(script.parseConnectLink(fixture)).toEqual(parseConnectLink(fixture));
    }
  });
});
