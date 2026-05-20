import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { discoverNatstackServersFromStatus } from "./tailscaleDiscovery";

describe("discoverNatstackServersFromStatus", () => {
  it("normalizes MagicDNS names and filters non-NatStack peers from a status fixture", async () => {
    const fixture = JSON.parse(
      fs.readFileSync(new URL("../../../tests/fixtures/tailscale-status.json", import.meta.url), {
        encoding: "utf8",
      })
    );
    const fetcher = vi.fn(async (url: URL | RequestInfo) => {
      if (String(url).includes("natstack.tailnet.ts.net")) {
        return new Response(
          JSON.stringify({
            ok: true,
            product: "natstack",
            discoveryVersion: 1,
            serverId: "srv_1",
            workspaceId: "ws_1",
          })
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await expect(
      discoverNatstackServersFromStatus(fixture, {
        timeoutMs: 100,
        fetcher: fetcher as typeof fetch,
      })
    ).resolves.toEqual([
      {
        url: "https://natstack.tailnet.ts.net",
        hostname: "natstack.tailnet.ts.net",
        serverId: "srv_1",
        workspaceId: "ws_1",
        discoveryVersion: 1,
      },
    ]);
    expect(fetcher.mock.calls.map(([url]) => new URL(String(url)).hostname)).not.toContain(
      "offline.tailnet.ts.net"
    );
  });

  it("probes known HTTP ports only when explicitly requested", async () => {
    const fetcher = vi.fn(async (url: URL | RequestInfo) => {
      const parsed = new URL(String(url));
      if (parsed.protocol === "http:" && parsed.port === "3030") {
        return new Response(JSON.stringify({ ok: true, product: "natstack", discoveryVersion: 1 }));
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    await expect(
      discoverNatstackServersFromStatus(
        { Peer: { a: { DNSName: "devbox.tailnet.ts.net.", Online: true } } },
        { timeoutMs: 100, probeKnownPorts: true, fetcher: fetcher as typeof fetch }
      )
    ).resolves.toEqual([
      {
        url: "http://devbox.tailnet.ts.net:3030",
        hostname: "devbox.tailnet.ts.net",
        discoveryVersion: 1,
        serverId: undefined,
        workspaceId: undefined,
      },
    ]);
  });
});
