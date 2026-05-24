import os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createConnectDeepLink,
  isTrustedCleartextHost,
  parseConnectLink,
  resolveServerRouteUrl,
  resolveServerWsUrl,
} from "./connect";

function ipv4(address: string): os.NetworkInterfaceInfo {
  return {
    family: "IPv4",
    address,
    internal: false,
    netmask: "255.255.255.0",
    mac: "00:00:00:00:00:00",
    cidr: `${address}/24`,
  };
}

describe("connect deep links", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("round-trips a pairing link", () => {
    const link = createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24));
    expect(parseConnectLink(link)).toEqual({
      kind: "ok",
      url: "https://host.tailnet.ts.net",
      code: "A".repeat(24),
    });
  });

  it("preserves supervisor tenant base paths in pairing links", () => {
    const link = createConnectDeepLink("https://host.test/base/w/alpha", "A".repeat(24));
    expect(parseConnectLink(link)).toEqual({
      kind: "ok",
      url: "https://host.test/base/w/alpha",
      code: "A".repeat(24),
    });
  });

  it("resolves HTTP and WebSocket routes under a canonical server base path", () => {
    expect(
      resolveServerRouteUrl("https://host.test/base/w/alpha", "/_r/s/auth/refresh-shell").href
    ).toBe("https://host.test/base/w/alpha/_r/s/auth/refresh-shell");
    expect(resolveServerRouteUrl("https://host.test/base/w/alpha/", "healthz").href).toBe(
      "https://host.test/base/w/alpha/healthz"
    );
    expect(resolveServerWsUrl("https://host.test/base/w/alpha")).toBe(
      "wss://host.test/base/w/alpha/rpc"
    );
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
      createStartRemotePairCommand: (url: string, code: string) => string;
      parseConnectLink: (raw: string) => unknown;
    };
    const fixtures = [
      createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24)),
      createConnectDeepLink("https://host.tailnet.ts.net/base/w/alpha", "A".repeat(24)),
      createConnectDeepLink("http://127.0.0.1:3030", "B".repeat(24)),
      createConnectDeepLink("http://example.com", "C".repeat(24)),
      "not-a-link",
      createConnectDeepLink("https://host.tailnet.ts.net", "short"),
    ];

    expect(script.createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24))).toBe(
      createConnectDeepLink("https://host.tailnet.ts.net", "A".repeat(24))
    );
    expect(script.createStartRemotePairCommand("https://host.tailnet.ts.net", "A".repeat(24))).toBe(
      `pnpm start:remote --pair '${createConnectDeepLink(
        "https://host.tailnet.ts.net",
        "A".repeat(24)
      )}'`
    );
    for (const fixture of fixtures) {
      expect(script.parseConnectLink(fixture)).toEqual(parseConnectLink(fixture));
    }
  });

  it("requires an actual Tailscale interface when the script selector is tailscale", async () => {
    const scriptUrl = new URL("../../../scripts/connect-utils.mjs", import.meta.url);
    const script = (await import(scriptUrl.href)) as {
      pickMobileHost: (
        preference: string,
        options?: { includeTunnel?: boolean }
      ) => {
        address: string;
      };
    };
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      eth0: [ipv4("192.168.1.20")],
    });

    expect(() => script.pickMobileHost("tailscale", { includeTunnel: true })).toThrow(
      "Could not detect a Tailscale IPv4 interface"
    );
    expect(script.pickMobileHost("vpn", { includeTunnel: true }).address).toBe("192.168.1.20");
  });

  it("selects a Tailscale address for the script tailscale selector", async () => {
    const scriptUrl = new URL("../../../scripts/connect-utils.mjs", import.meta.url);
    const script = (await import(scriptUrl.href)) as {
      pickMobileHost: (
        preference: string,
        options?: { includeTunnel?: boolean }
      ) => {
        address: string;
      };
    };
    vi.spyOn(os, "networkInterfaces").mockReturnValue({
      eth0: [ipv4("192.168.1.20")],
      tailscale0: [ipv4("100.75.165.121")],
    });

    expect(script.pickMobileHost("tailscale", { includeTunnel: true }).address).toBe(
      "100.75.165.121"
    );
  });
});
