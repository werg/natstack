import { describe, expect, it, beforeEach, vi } from "vitest";
import { TokenManager } from "./tokenManager.js";

describe("TokenManager", () => {
  let tm: TokenManager;

  beforeEach(() => {
    tm = new TokenManager();
  });

  it("creates and validates non-panel caller tokens", () => {
    const token = tm.createToken("worker:one", "worker");
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(tm.validateToken(token)).toEqual({ callerId: "worker:one", callerKind: "worker" });
  });

  it("rejects panel bearer tokens", () => {
    expect(() => tm.createToken("panel:one", "panel")).toThrow(/Panel bearer tokens/);
  });

  it("ensureWorkerBearer returns an existing worker token", () => {
    const first = tm.ensureWorkerBearer("worker:one");
    const second = tm.ensureWorkerBearer("worker:one");
    expect(second).toBe(first);
    expect(tm.validateWorkerBearer(first)).toEqual({ callerId: "worker:one" });
  });

  it("validateWorkerBearer rejects non-worker tokens", () => {
    const token = tm.ensureToken("shell:one", "shell");
    expect(tm.validateWorkerBearer(token)).toBeNull();
  });

  it("getToken throws if callerId not found", () => {
    expect(() => tm.getToken("unknown")).toThrow('No token exists for caller "unknown"');
  });

  it("revokeToken removes token and notifies listeners", () => {
    const listener = vi.fn();
    tm.onRevoke(listener);
    const token = tm.createToken("worker:one", "worker");

    expect(tm.revokeToken("worker:one")).toBe(true);
    expect(tm.validateToken(token)).toBeNull();
    expect(listener).toHaveBeenCalledWith("worker:one");
  });

  it("clear removes all tokens and notifies for each", () => {
    const listener = vi.fn();
    tm.onRevoke(listener);
    tm.createToken("worker:a", "worker");
    tm.createToken("shell:b", "shell");

    tm.clear();

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledWith("worker:a");
    expect(listener).toHaveBeenCalledWith("shell:b");
  });

  it("setAdminToken / validateAdminToken", () => {
    expect(tm.validateAdminToken("secret")).toBe(false);
    tm.setAdminToken("secret");
    expect(tm.validateAdminToken("secret")).toBe(true);
    expect(tm.validateAdminToken("wrong")).toBe(false);
  });
});
