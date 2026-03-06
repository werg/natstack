/**
 * Tests for service access policy checking.
 */

import { checkServiceAccess, type PolicyRegistry } from "./servicePolicy.js";

function makeRegistry(policies: Record<string, { allowed: string[] }>): PolicyRegistry {
  return {
    getPolicy: (service) => {
      const p = policies[service];
      return p ? { allowed: p.allowed as any[] } : undefined;
    },
  };
}

describe("checkServiceAccess", () => {
  const registry = makeRegistry({
    app: { allowed: ["shell"] },
    panel: { allowed: ["shell"] },
    view: { allowed: ["shell"] },
    workspace: { allowed: ["shell"] },
    central: { allowed: ["shell"] },
    settings: { allowed: ["shell"] },
    menu: { allowed: ["shell"] },
    bridge: { allowed: ["panel", "shell", "server"] },
    ai: { allowed: ["shell", "panel", "server"] },
    db: { allowed: ["shell", "panel", "server"] },
    tokens: { allowed: ["server"] },
    fs: { allowed: ["panel", "server"] },
  });

  it("allows shell to access shell-only services", () => {
    for (const svc of ["app", "panel", "view", "workspace", "central", "settings", "menu"]) {
      expect(() => checkServiceAccess(svc, "shell", registry)).not.toThrow();
    }
  });

  it("denies panel access to shell-only services", () => {
    expect(() => checkServiceAccess("app", "panel", registry)).toThrow(
      "not accessible to panel callers"
    );
  });

  it("allows panel, shell, and server to access bridge", () => {
    expect(() => checkServiceAccess("bridge", "panel", registry)).not.toThrow();
    expect(() => checkServiceAccess("bridge", "shell", registry)).not.toThrow();
    expect(() => checkServiceAccess("bridge", "server", registry)).not.toThrow();
  });

  it("allows server to access tokens and denies others", () => {
    expect(() => checkServiceAccess("tokens", "server", registry)).not.toThrow();
    expect(() => checkServiceAccess("tokens", "shell", registry)).toThrow(
      "not accessible to shell callers"
    );
    expect(() => checkServiceAccess("tokens", "panel", registry)).toThrow(
      "not accessible to panel callers"
    );
  });

  it("returns void (no throw) for unknown services", () => {
    expect(() => checkServiceAccess("nonexistent", "panel", registry)).not.toThrow();
  });

  it("uses registry for policy lookup", () => {
    const customRegistry = makeRegistry({
      custom: { allowed: ["server"] },
    });

    expect(() => checkServiceAccess("custom", "server", customRegistry)).not.toThrow();
    expect(() => checkServiceAccess("custom", "panel", customRegistry)).toThrow(
      "not accessible to panel callers"
    );
  });
});
