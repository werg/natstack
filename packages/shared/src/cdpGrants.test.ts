import { describe, expect, it } from "vitest";
import { CdpGrantService } from "./cdpGrants.js";

describe("CdpGrantService", () => {
  it("redeems a browser-bound grant once", () => {
    const grants = new CdpGrantService();
    const { token } = grants.grant("panel:one", "browser:one");

    expect(grants.redeem(token, "browser:one")).toEqual({ principalId: "panel:one" });
    expect(grants.redeem(token, "browser:one")).toBeNull();
    grants.stop();
  });

  it("rejects grants for another browser", () => {
    const grants = new CdpGrantService();
    const { token } = grants.grant("panel:one", "browser:one");

    expect(grants.redeem(token, "browser:two")).toBeNull();
    grants.stop();
  });
});
