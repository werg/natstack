import { beforeEach, describe, expect, it } from "vitest";
import { EntityCache } from "./entityCache.js";
import type { EntityRecord } from "./entitySpec.js";

function makeRecord(overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: overrides.id ?? "panel:test",
    kind: overrides.kind ?? "panel",
    source: overrides.source ?? { repoPath: "panels/test", effectiveVersion: "v1" },
    contextId: overrides.contextId ?? "ctx-1",
    key: overrides.key ?? "test",
    createdAt: overrides.createdAt ?? Date.now(),
    status: overrides.status ?? "active",
    cleanupComplete: overrides.cleanupComplete ?? true,
    ...(overrides.className !== undefined ? { className: overrides.className } : {}),
    ...(overrides.stateArgs !== undefined ? { stateArgs: overrides.stateArgs } : {}),
    ...(overrides.retiredAt !== undefined ? { retiredAt: overrides.retiredAt } : {}),
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
  };
}

describe("EntityCache", () => {
  let cache: EntityCache;
  beforeEach(() => {
    cache = new EntityCache();
  });

  describe("resolveActive", () => {
    it("returns the record for active rows", () => {
      const rec = makeRecord({ id: "panel:active", status: "active" });
      cache._onActivate(rec);
      expect(cache.resolveActive("panel:active")).toMatchObject({ id: "panel:active" });
    });

    it("returns null for retired rows", () => {
      const rec = makeRecord({ id: "panel:retired", status: "active" });
      cache._onActivate(rec);
      cache._onRetire({ ...rec, status: "retired", retiredAt: Date.now(), cleanupComplete: false });
      expect(cache.resolveActive("panel:retired")).toBeNull();
      // But resolve() still finds it (grace-window observability).
      expect(cache.resolve("panel:retired")?.status).toBe("retired");
    });

    it("returns null for unknown ids", () => {
      expect(cache.resolveActive("panel:nope")).toBeNull();
    });
  });

  describe("_onActivate", () => {
    it("updates an existing row's status without changing identity", () => {
      const rec = makeRecord({
        id: "panel:x",
        status: "retired",
        retiredAt: 1,
        cleanupComplete: false,
      });
      cache._onActivate(rec);
      const updated = { ...rec, status: "active" as const, cleanupComplete: true };
      delete (updated as Partial<EntityRecord>).retiredAt;
      cache._onActivate(updated);
      const stored = cache.resolve("panel:x");
      expect(stored?.status).toBe("active");
      expect(stored?.id).toBe("panel:x");
      expect(stored?.key).toBe(rec.key);
    });
  });

  describe("_onRetire", () => {
    it("marks status retired but keeps the row in the cache", () => {
      const rec = makeRecord({ id: "panel:r1" });
      cache._onActivate(rec);
      cache._onRetire({ ...rec, status: "retired", retiredAt: 1, cleanupComplete: false });
      const stored = cache.resolve("panel:r1");
      expect(stored?.status).toBe("retired");
    });
  });

  describe("_onDelete", () => {
    it("removes the row from the cache", () => {
      const rec = makeRecord({ id: "panel:d1" });
      cache._onActivate(rec);
      cache._onDelete("panel:d1");
      expect(cache.resolve("panel:d1")).toBeNull();
    });

    it("is a no-op for unknown ids", () => {
      expect(() => cache._onDelete("panel:unknown")).not.toThrow();
    });
  });

  describe("registerBootstrap", () => {
    it("registers a server entry", () => {
      cache.registerBootstrap({ id: "server:main", kind: "server", contextId: "ctx-srv" });
      const rec = cache.resolve("server:main");
      expect(rec?.kind).toBe("server");
      expect(rec?.contextId).toBe("ctx-srv");
      expect(rec?.status).toBe("active");
    });

    it("registers a shell entry", () => {
      cache.registerBootstrap({ id: "shell:main", kind: "shell" });
      const rec = cache.resolve("shell:main");
      expect(rec?.kind).toBe("shell");
      expect(rec?.status).toBe("active");
    });
  });

  describe("hydrate / listActive", () => {
    it("hydrate replaces the cache contents", () => {
      cache._onActivate(makeRecord({ id: "panel:old" }));
      cache.hydrate([makeRecord({ id: "panel:new" })]);
      expect(cache.resolve("panel:old")).toBeNull();
      expect(cache.resolve("panel:new")).not.toBeNull();
    });

    it("listActive returns only active records", () => {
      const a = makeRecord({ id: "panel:a", status: "active" });
      const b = makeRecord({ id: "panel:b", status: "retired", retiredAt: 1 });
      cache._onActivate(a);
      cache._onActivate(b);
      expect(cache.listActive().map((r) => r.id)).toEqual(["panel:a"]);
    });
  });
});
