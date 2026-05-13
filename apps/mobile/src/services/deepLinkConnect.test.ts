import { isTrustedCleartextHost, parseConnectDeepLink } from "./deepLinkConnect";

describe("deepLinkConnect", () => {
  it("allows trusted cleartext hosts used by internal phone pairing", () => {
    expect(isTrustedCleartextHost("localhost")).toBe(true);
    expect(isTrustedCleartextHost("192.168.1.20")).toBe(true);
    expect(isTrustedCleartextHost("100.73.236.5")).toBe(true);
    expect(isTrustedCleartextHost("server.tailnet.ts.net")).toBe(true);
    expect(isTrustedCleartextHost("pop-os")).toBe(true);
    expect(isTrustedCleartextHost("pop-os.local")).toBe(true);
  });

  it("rejects cleartext public hostnames", () => {
    expect(isTrustedCleartextHost("example.com")).toBe(false);
    expect(isTrustedCleartextHost("natstack.example.com")).toBe(false);
  });

  it("parses a connect link with a single-label local hostname", () => {
    const result = parseConnectDeepLink(
      "natstack://connect?url=http%3A%2F%2Fpop-os%3A3030&code=abc123abc123abc123",
    );

    expect(result).toEqual({
      kind: "ok",
      serverUrl: "http://pop-os:3030",
      pairingCode: "abc123abc123abc123",
    });
  });
});
