import { describe, expect, it } from "vitest";
import { interpretTailscaleStatus } from "./vpnDetect.js";

describe("interpretTailscaleStatus", () => {
  it("returns a public URL when MagicDNS hostname is available", () => {
    const result = interpretTailscaleStatus({
      BackendState: "Running",
      Self: {
        HostName: "pop-os",
        DNSName: "pop-os.tailnet-xyz.ts.net.",
        TailscaleIPs: ["100.73.236.5"],
        Online: true,
      },
      MagicDNSSuffix: "tailnet-xyz.ts.net.",
      CurrentTailnet: { Name: "Werg's tailnet", MagicDNSEnabled: true },
    });
    expect(result).not.toBeNull();
    expect(result!.vendor).toBe("tailscale");
    expect(result!.hostname).toBe("pop-os.tailnet-xyz.ts.net");
    expect(result!.url).toBe("https://pop-os.tailnet-xyz.ts.net");
    expect(result!.raw).toMatchObject({ tailnet: "Werg's tailnet" });
  });

  it("returns null when Tailscale is not running", () => {
    const result = interpretTailscaleStatus({
      BackendState: "Stopped",
      Self: { DNSName: "pop-os.example.ts.net." },
    });
    expect(result).toBeNull();
  });

  it("returns null when MagicDNS is disabled", () => {
    const result = interpretTailscaleStatus({
      BackendState: "Running",
      Self: { DNSName: "pop-os.example.ts.net." },
      CurrentTailnet: { MagicDNSEnabled: false },
    });
    expect(result).toBeNull();
  });

  it("returns null when Self.Online is false", () => {
    const result = interpretTailscaleStatus({
      BackendState: "Running",
      Self: { DNSName: "host.tailnet.ts.net.", Online: false },
      CurrentTailnet: { MagicDNSEnabled: true },
    });
    expect(result).toBeNull();
  });

  it("returns null when no DNS name is set", () => {
    const result = interpretTailscaleStatus({
      BackendState: "Running",
      Self: { HostName: "pop-os", TailscaleIPs: ["100.73.236.5"] },
    });
    expect(result).toBeNull();
  });

  it("strips trailing dot from FQDN", () => {
    const result = interpretTailscaleStatus({
      BackendState: "Running",
      Self: { DNSName: "host.tailnet.ts.net." },
      CurrentTailnet: { MagicDNSEnabled: true },
    });
    expect(result!.hostname).toBe("host.tailnet.ts.net");
  });

  it("falls back to legacy MagicDNS.Suffix shape from older CLIs", () => {
    const result = interpretTailscaleStatus({
      BackendState: "Running",
      Self: { DNSName: "host.tailnet.ts.net." },
      MagicDNS: { Suffix: "tailnet.ts.net.", Enabled: true },
    });
    expect(result!.hostname).toBe("host.tailnet.ts.net");
  });

  it("returns null when legacy MagicDNS.Enabled is explicitly false", () => {
    const result = interpretTailscaleStatus({
      BackendState: "Running",
      Self: { DNSName: "host.tailnet.ts.net." },
      MagicDNS: { Suffix: "tailnet.ts.net.", Enabled: false },
    });
    expect(result).toBeNull();
  });

  it("falls back to CurrentTailnet.MagicDNSSuffix when top-level is missing", () => {
    const result = interpretTailscaleStatus({
      BackendState: "Running",
      Self: { DNSName: "host.tailnet.ts.net." },
      CurrentTailnet: { MagicDNSEnabled: true, MagicDNSSuffix: "tailnet.ts.net." },
    });
    expect(result!.hostname).toBe("host.tailnet.ts.net");
  });

  it("includes a setup hint mentioning tailscale serve", () => {
    const result = interpretTailscaleStatus({
      BackendState: "Running",
      Self: { DNSName: "host.tailnet.ts.net." },
      CurrentTailnet: { MagicDNSEnabled: true },
    });
    expect(result!.setupHint).toMatch(/tailscale serve/);
  });
});
