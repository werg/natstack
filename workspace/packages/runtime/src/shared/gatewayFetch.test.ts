import { afterEach, describe, expect, it, vi } from "vitest";
import { createGatewayFetch } from "./gatewayFetch.js";

describe("createGatewayFetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function captureFetch() {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        calls.push({ url: String(url), init });
        return new Response("ok");
      }),
    );
    return calls;
  }

  it("prefixes relative paths and attaches the bearer", async () => {
    const calls = captureFetch();
    const gw = createGatewayFetch({ serverUrl: "http://gw.test", token: "T" });
    await gw("/some/route");
    expect(calls[0]!.url).toBe("http://gw.test/some/route");
    expect(new Headers(calls[0]!.init!.headers).get("Authorization")).toBe("Bearer T");
  });

  it("default mode passes absolute URLs through (panel/worker parity)", async () => {
    const calls = captureFetch();
    const gw = createGatewayFetch({ serverUrl: "http://gw.test", token: "T" });
    await gw("https://elsewhere.test/x");
    expect(calls[0]!.url).toBe("https://elsewhere.test/x");
  });

  describe("relativeOnly (EvalDO SSRF guard)", () => {
    it("allows gateway-relative paths", async () => {
      const calls = captureFetch();
      const gw = createGatewayFetch({ serverUrl: "http://gw.test", token: "T", relativeOnly: true });
      await gw("/build/artifact");
      expect(calls[0]!.url).toBe("http://gw.test/build/artifact");
    });

    it("rejects absolute http(s) URLs (no bearer exfil to external host)", async () => {
      captureFetch();
      const gw = createGatewayFetch({ serverUrl: "http://gw.test", token: "T", relativeOnly: true });
      await expect(gw("https://evil.test/steal")).rejects.toThrow(/only gateway-relative/);
    });

    it("rejects protocol-relative URLs that resolve to a foreign origin", async () => {
      captureFetch();
      const gw = createGatewayFetch({ serverUrl: "http://gw.test", token: "T", relativeOnly: true });
      await expect(gw("//evil.test/steal")).rejects.toThrow(/only gateway-relative/);
    });

    it("does not let `..` escape the gateway origin", async () => {
      const calls = captureFetch();
      const gw = createGatewayFetch({ serverUrl: "http://gw.test", token: "T", relativeOnly: true });
      await gw("/a/../../b");
      expect(new URL(calls[0]!.url).origin).toBe("http://gw.test");
    });
  });

  describe("panel tunnel (shell bridge)", () => {
    function stubPanel(
      stream = vi.fn((_envelope: unknown, _signal?: unknown) =>
        Promise.resolve(new Response("tunneled")),
      ),
    ) {
      vi.stubGlobal("__natstackShell", { stream });
      vi.stubGlobal("__natstackEntityId", "panel:p1");
      return stream;
    }

    it("tunnels over the bridge stream() instead of an authenticated HTTP fetch", async () => {
      const calls = captureFetch();
      const stream = stubPanel();
      const gw = createGatewayFetch({ serverUrl: "http://gw.test", token: "T" });

      const res = await gw("/some/route");

      expect(await res.text()).toBe("tunneled");
      // No direct HTTP request — the bearer never rides any wire.
      expect(calls).toHaveLength(0);
      expect(stream).toHaveBeenCalledTimes(1);
      const envelope = stream.mock.calls[0]![0] as unknown as {
        target: string;
        delivery: { caller: unknown };
        message: { type: string; method: string; args: Array<Record<string, unknown>> };
      };
      expect(envelope.target).toBe("main");
      expect(envelope.delivery.caller).toEqual({ callerId: "panel:p1", callerKind: "panel" });
      expect(envelope.message.type).toBe("stream-request");
      expect(envelope.message.method).toBe("gateway.fetch");
      expect(envelope.message.args[0]).toMatchObject({ path: "/some/route", method: "GET" });
    });

    it("keeps the relativeOnly guard before tunneling", async () => {
      stubPanel();
      const gw = createGatewayFetch({ serverUrl: "http://gw.test", token: "T", relativeOnly: true });
      await expect(gw("https://evil.test/steal")).rejects.toThrow(/only gateway-relative/);
    });

    it("fails loud when the host has not wired stream()", async () => {
      captureFetch();
      vi.stubGlobal("__natstackShell", {}); // bridge present, stream() not wired
      vi.stubGlobal("__natstackEntityId", "panel:p1");
      const gw = createGatewayFetch({ serverUrl: "http://gw.test", token: "T" });
      await expect(gw("/x")).rejects.toThrow(/stream\(\) is unavailable/);
    });
  });
});
