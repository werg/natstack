/**
 * Tests for service access policies.
 */

import {
  checkServiceAccess,
  hasServicePolicy,
  getAccessibleServices,
  SERVICE_POLICIES,
} from "./servicePolicy.js";

describe("checkServiceAccess", () => {
  it("allows shell to access shell-only services", () => {
    for (const svc of ["app", "panel", "view", "workspace", "central", "settings", "menu"]) {
      expect(() => checkServiceAccess(svc, "shell")).not.toThrow();
    }
  });

  it("denies panel access to shell-only services", () => {
    expect(() => checkServiceAccess("app", "panel")).toThrow(
      "not accessible to panel callers"
    );
  });

  it("allows panel, shell, and server to access bridge", () => {
    expect(() => checkServiceAccess("bridge", "panel")).not.toThrow();
    expect(() => checkServiceAccess("bridge", "shell")).not.toThrow();
    expect(() => checkServiceAccess("bridge", "server")).not.toThrow();
  });

  it("allows server to access tokens and denies others", () => {
    expect(() => checkServiceAccess("tokens", "server")).not.toThrow();
    expect(() => checkServiceAccess("tokens", "shell")).toThrow(
      "not accessible to shell callers"
    );
    expect(() => checkServiceAccess("tokens", "panel")).toThrow(
      "not accessible to panel callers"
    );
  });

  it("returns void (no throw) for unknown services", () => {
    expect(() => checkServiceAccess("nonexistent", "panel")).not.toThrow();
  });
});

describe("hasServicePolicy", () => {
  it("returns true for known services", () => {
    expect(hasServicePolicy("ai")).toBe(true);
    expect(hasServicePolicy("db")).toBe(true);
  });

  it("returns false for unknown services", () => {
    expect(hasServicePolicy("unknown-svc")).toBe(false);
  });
});

describe("getAccessibleServices", () => {
  it("returns the correct services for each caller kind", () => {
    const shellServices = getAccessibleServices("shell");
    // Shell can access shell-only services
    expect(shellServices).toContain("app");
    expect(shellServices).toContain("settings");
    // Shell can also access shared services
    expect(shellServices).toContain("ai");
    expect(shellServices).toContain("bridge");
    // Shell cannot access server-only
    expect(shellServices).not.toContain("tokens");

    const panelServices = getAccessibleServices("panel");
    expect(panelServices).toContain("bridge");
    expect(panelServices).toContain("ai");
    expect(panelServices).not.toContain("app");
    expect(panelServices).not.toContain("tokens");

    const serverServices = getAccessibleServices("server");
    expect(serverServices).toContain("tokens");
    expect(serverServices).toContain("bridge");
    expect(serverServices).not.toContain("app");
  });
});
