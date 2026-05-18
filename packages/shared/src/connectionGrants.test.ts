import { describe, expect, it } from "vitest";
import { ConnectionGrantService } from "./connectionGrants.js";
import { PrincipalRegistry } from "./principalRegistry.js";

describe("ConnectionGrantService", () => {
  it("throws when granting an unregistered principal", () => {
    const grants = new ConnectionGrantService({ registry: new PrincipalRegistry() });
    expect(() => grants.grant("panel:missing", "shell:test")).toThrow(/unregistered/);
    grants.stop();
  });

  it("redeems grants once", () => {
    const registry = new PrincipalRegistry();
    registry.register({ id: "panel:one", kind: "panel" });
    const grants = new ConnectionGrantService({ registry });
    const { token } = grants.grant("panel:one", "shell:test");

    expect(grants.redeem(token)).toEqual({ principalId: "panel:one", issuedBy: "shell:test" });
    expect(grants.redeem(token)).toBeNull();
    grants.stop();
  });

  it("rejects expired grants", async () => {
    const registry = new PrincipalRegistry();
    registry.register({ id: "panel:one", kind: "panel" });
    const grants = new ConnectionGrantService({ registry });
    const { token } = grants.grant("panel:one", "shell:test", 1);
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(grants.redeem(token)).toBeNull();
    grants.stop();
  });
});
