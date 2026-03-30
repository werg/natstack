/**
 * Tests for TokenManager and GitAuthManager.
 */

import { TokenManager, GitAuthManager } from "./tokenManager.js";

describe("TokenManager", () => {
  let tm: TokenManager;

  beforeEach(() => {
    tm = new TokenManager();
  });

  it("createToken returns a hex string and can be validated", () => {
    const token = tm.createToken("panel-1", "panel");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const entry = tm.validateToken(token);
    expect(entry).toEqual({ callerId: "panel-1", callerKind: "panel" });
  });

  it("createToken throws if duplicate callerId", () => {
    tm.createToken("panel-1", "panel");
    expect(() => tm.createToken("panel-1", "panel")).toThrow(
      'Token already exists for caller "panel-1"'
    );
  });

  it("ensureToken returns existing token for same callerId", () => {
    const first = tm.ensureToken("panel-1", "panel");
    const second = tm.ensureToken("panel-1", "panel");
    expect(second).toBe(first);
  });

  it("ensureToken creates token if none exists", () => {
    const token = tm.ensureToken("panel-1", "shell");
    expect(tm.validateToken(token)).toEqual({ callerId: "panel-1", callerKind: "shell" });
  });

  it("getToken throws if callerId not found", () => {
    expect(() => tm.getToken("unknown")).toThrow('No token exists for caller "unknown"');
  });

  it("getToken returns existing token", () => {
    const created = tm.createToken("panel-1", "panel");
    expect(tm.getToken("panel-1")).toBe(created);
  });

  it("validateToken returns null for unknown token", () => {
    expect(tm.validateToken("bad-token")).toBeNull();
  });

  it("getPanelIdFromToken returns callerId or null", () => {
    const token = tm.createToken("panel-1", "panel");
    expect(tm.getPanelIdFromToken(token)).toBe("panel-1");
    expect(tm.getPanelIdFromToken("bogus")).toBeNull();
  });

  it("revokeToken removes token and notifies listeners", () => {
    const listener = vi.fn();
    tm.onRevoke(listener);
    const token = tm.createToken("panel-1", "panel");

    expect(tm.revokeToken("panel-1")).toBe(true);
    expect(tm.validateToken(token)).toBeNull();
    expect(listener).toHaveBeenCalledWith("panel-1");
  });

  it("revokeToken returns false for unknown callerId", () => {
    expect(tm.revokeToken("nope")).toBe(false);
  });

  it("clear removes all tokens and notifies for each", () => {
    const listener = vi.fn();
    tm.onRevoke(listener);
    tm.createToken("a", "panel");
    tm.createToken("b", "shell");

    tm.clear();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith("a");
    expect(listener).toHaveBeenCalledWith("b");
  });

  it("setAdminToken / validateAdminToken", () => {
    expect(tm.validateAdminToken("secret")).toBe(false);
    tm.setAdminToken("secret");
    expect(tm.validateAdminToken("secret")).toBe(true);
    expect(tm.validateAdminToken("wrong")).toBe(false);
  });
});

describe("GitAuthManager", () => {
  let tm: TokenManager;
  let gam: GitAuthManager;

  beforeEach(() => {
    tm = new TokenManager();
    gam = new GitAuthManager(tm);
  });

  it("fetch is always allowed", () => {
    expect(gam.canAccess("panel-1", "tree/other", "fetch")).toEqual({
      allowed: true,
    });
  });

  it("push to non-protected path is allowed", () => {
    expect(gam.canAccess("panel-1", "shared/repo", "push")).toEqual({
      allowed: true,
    });
  });

  it("push to own tree path is allowed", () => {
    expect(gam.canAccess("tree/my-panel", "tree/my-panel", "push")).toEqual({
      allowed: true,
    });
    // sub-path also allowed
    expect(
      gam.canAccess("tree/my-panel", "tree/my-panel/sub-repo", "push")
    ).toEqual({ allowed: true });
  });

  it("push to other panel tree path is denied", () => {
    const result = gam.canAccess("tree/panel-a", "tree/panel-b", "push");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("cannot push");
  });

  it("normalizes .git suffix and leading slashes", () => {
    // tree/my-panel.git should normalize to tree/my-panel
    expect(
      gam.canAccess("tree/my-panel", "/tree/my-panel.git", "push")
    ).toEqual({ allowed: true });
  });

  it("validateAccess rejects invalid token", () => {
    const result = gam.validateAccess("bad-token", "some-repo", "fetch");
    expect(result).toEqual({ valid: false, reason: "Invalid token" });
  });

  it("validateAccess checks access after token validation", () => {
    const token = tm.createToken("tree/panel-a", "panel");
    const ok = gam.validateAccess(token, "tree/panel-a", "push");
    expect(ok).toEqual({ valid: true });

    const denied = gam.validateAccess(token, "tree/panel-b", "push");
    expect(denied.valid).toBe(false);
  });
});
