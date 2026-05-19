/**
 * Unit tests for RouteRegistry — registration, lookup, reconciliation.
 */

import { describe, it, expect } from "vitest";
import {
  RouteRegistry,
  canonicalInstanceName,
  type ManifestRouteDecl,
  type ServiceRouteDecl,
} from "./routeRegistry.js";
import { SingletonRegistry } from "@natstack/shared/workspace/singletonRegistry";

function makeDecl(overrides: Partial<ManifestRouteDecl> = {}): ManifestRouteDecl {
  return { source: "workers/foo", path: "/hello", worker: true, ...overrides };
}

function makeSingletons(
  rows: Array<{ source: string; className: string; key: string }>
): SingletonRegistry {
  return new SingletonRegistry(rows);
}

describe("RouteRegistry", () => {
  describe("worker routes — DO-backed", () => {
    it("registers and looks up a DO route", () => {
      const reg = new RouteRegistry();
      const singletons = makeSingletons([
        { source: "workers/foo", className: "MyDO", key: "singleton" },
      ]);
      reg.registerDoRoutes(
        "workers/foo",
        "MyDO",
        [makeDecl({ path: "/callback", worker: undefined, durableObject: { className: "MyDO" } })],
        singletons
      );
      const res = reg.lookup("/_r/w/workers/foo/callback", "GET", false);
      expect(res).toMatchObject({
        kind: "worker-do",
        source: "workers/foo",
        className: "MyDO",
        objectKey: "singleton",
        remainder: "/callback",
      });
    });

    it("uses the singleton key from the singletonRegistry", () => {
      const reg = new RouteRegistry();
      const singletons = makeSingletons([
        { source: "workers/foo", className: "A", key: "tenant-1" },
      ]);
      reg.registerDoRoutes(
        "workers/foo",
        "A",
        [makeDecl({ worker: undefined, durableObject: { className: "A" } })],
        singletons
      );
      const res = reg.lookup("/_r/w/workers/foo/hello", "GET", false);
      expect(res).toMatchObject({ kind: "worker-do", objectKey: "tenant-1" });
    });

    it("filters by className — routes for other classes are ignored", () => {
      const reg = new RouteRegistry();
      const singletons = makeSingletons([
        { source: "workers/foo", className: "A", key: "a-key" },
        { source: "workers/foo", className: "B", key: "b-key" },
      ]);
      reg.registerDoRoutes(
        "workers/foo",
        "A",
        [
          makeDecl({ path: "/a", worker: undefined, durableObject: { className: "A" } }),
          makeDecl({ path: "/b", worker: undefined, durableObject: { className: "B" } }),
        ],
        singletons
      );
      expect(reg.lookup("/_r/w/workers/foo/a", "GET", false)).not.toBeNull();
      expect(reg.lookup("/_r/w/workers/foo/b", "GET", false)).toBeNull();
    });

    it("throws when no singleton row exists for (source, className)", () => {
      const reg = new RouteRegistry();
      const singletons = makeSingletons([]);
      expect(() =>
        reg.registerDoRoutes(
          "workers/foo",
          "A",
          [makeDecl({ worker: undefined, durableObject: { className: "A" } })],
          singletons
        )
      ).toThrow(/Missing singletonObjects/);
    });
  });

  describe("worker routes — regular", () => {
    it("registers a regular-worker route on canonical instance only", () => {
      const reg = new RouteRegistry();
      reg.registerWorkerRoutes("workers/foo", "foo", [makeDecl()]);
      const res = reg.lookup("/_r/w/workers/foo/hello", "GET", false);
      expect(res).toMatchObject({
        kind: "worker-regular",
        source: "workers/foo",
        targetInstanceName: "foo",
      });
    });

    it("skips DO routes when asked to register regular-worker routes", () => {
      const reg = new RouteRegistry();
      reg.registerWorkerRoutes("workers/foo", "foo", [
        makeDecl({ path: "/x" }),
        makeDecl({ path: "/y", worker: undefined, durableObject: { className: "DO1" } }),
      ]);
      expect(reg.lookup("/_r/w/workers/foo/x", "GET", false)).not.toBeNull();
      expect(reg.lookup("/_r/w/workers/foo/y", "GET", false)).toBeNull();
    });

    it("unregisters on canonical instance teardown", () => {
      const reg = new RouteRegistry();
      reg.registerWorkerRoutes("workers/foo", "foo", [makeDecl()]);
      reg.unregisterWorkerRoutes("workers/foo");
      expect(reg.lookup("/_r/w/workers/foo/hello", "GET", false)).toBeNull();
    });

    it("preserves DO routes when regular routes are unregistered", () => {
      const reg = new RouteRegistry();
      const singletons = makeSingletons([
        { source: "workers/foo", className: "DO1", key: "singleton" },
      ]);
      reg.registerDoRoutes(
        "workers/foo",
        "DO1",
        [makeDecl({ path: "/do", worker: undefined, durableObject: { className: "DO1" } })],
        singletons
      );
      reg.registerWorkerRoutes("workers/foo", "foo", [makeDecl({ path: "/reg" })]);
      reg.unregisterWorkerRoutes("workers/foo");
      expect(reg.lookup("/_r/w/workers/foo/reg", "GET", false)).toBeNull();
      expect(reg.lookup("/_r/w/workers/foo/do", "GET", false)).not.toBeNull();
    });
  });

  describe("service routes", () => {
    it("dispatches to the matching handler", () => {
      const reg = new RouteRegistry();
      const handler = () => {};
      const decl: ServiceRouteDecl = {
        serviceName: "auth",
        path: "/oauth/callback",
        handler,
      };
      reg.registerService([decl]);
      const res = reg.lookup("/_r/s/auth/oauth/callback", "GET", false);
      expect(res).toMatchObject({ kind: "service", serviceName: "auth" });
      if (res && res !== "method-not-allowed" && res.kind === "service") {
        expect(res.handler).toBe(handler);
      }
    });

    it("extracts :params", () => {
      const reg = new RouteRegistry();
      reg.registerService([
        {
          serviceName: "svc",
          path: "/webhook/:id",
          handler: () => {},
        },
      ]);
      const res = reg.lookup("/_r/s/svc/webhook/abc-123", "POST", false);
      expect(res).not.toBeNull();
      if (res && res !== "method-not-allowed" && res.kind === "service") {
        expect(res.params).toEqual({ id: "abc-123" });
      }
    });

    it("returns method-not-allowed for method mismatch with path match", () => {
      const reg = new RouteRegistry();
      reg.registerService([
        {
          serviceName: "svc",
          path: "/x",
          methods: ["GET"],
          handler: () => {},
        },
      ]);
      expect(reg.lookup("/_r/s/svc/x", "POST", false)).toBe("method-not-allowed");
    });
  });

  describe("auth & ws gating", () => {
    it("defaults to public auth", () => {
      const reg = new RouteRegistry();
      reg.registerService([{ serviceName: "s", path: "/x", handler: () => {} }]);
      const res = reg.lookup("/_r/s/s/x", "GET", false);
      expect(res).toMatchObject({ auth: "public" });
    });

    it("admin-token auth is surfaced to the gateway", () => {
      const reg = new RouteRegistry();
      reg.registerService([
        {
          serviceName: "s",
          path: "/x",
          auth: "admin-token",
          handler: () => {},
        },
      ]);
      const res = reg.lookup("/_r/s/s/x", "GET", false);
      expect(res).toMatchObject({ auth: "admin-token" });
    });

    it("caller-token auth is surfaced to the gateway", () => {
      const reg = new RouteRegistry();
      reg.registerService([
        {
          serviceName: "s",
          path: "/x",
          auth: "caller-token",
          handler: () => {},
        },
      ]);
      const res = reg.lookup("/_r/s/s/x", "GET", false);
      expect(res).toMatchObject({ auth: "caller-token" });
    });

    it("non-ws routes are not matched for upgrade requests", () => {
      const reg = new RouteRegistry();
      reg.registerService([{ serviceName: "s", path: "/x", handler: () => {} }]);
      expect(reg.lookup("/_r/s/s/x", "GET", true)).toBeNull();
    });

    it("ws routes only match upgrade when websocket=true", () => {
      const reg = new RouteRegistry();
      reg.registerService([
        {
          serviceName: "s",
          path: "/x",
          websocket: true,
          handler: () => {},
          onUpgrade: () => {},
        },
      ]);
      expect(reg.lookup("/_r/s/s/x", "GET", true)).not.toBeNull();
    });
  });

  describe("miss & malformed paths", () => {
    it("returns null for non-`/_r/` paths", () => {
      const reg = new RouteRegistry();
      expect(reg.lookup("/foo", "GET", false)).toBeNull();
      expect(reg.lookup("/_w/workers/foo/x", "GET", false)).toBeNull();
    });

    it("returns null for too-short worker paths", () => {
      const reg = new RouteRegistry();
      expect(reg.lookup("/_r/w/onlyone", "GET", false)).toBeNull();
    });

    it("returns null for unknown service names", () => {
      const reg = new RouteRegistry();
      expect(reg.lookup("/_r/s/unknown/x", "GET", false)).toBeNull();
    });
  });

  describe("reconcileWorkerRoutes", () => {
    it("drops routes no longer in the manifest", () => {
      const reg = new RouteRegistry();
      const singletons = makeSingletons([]);
      reg.registerWorkerRoutes("workers/foo", "foo", [
        makeDecl({ path: "/a" }),
        makeDecl({ path: "/b" }),
      ]);
      reg.reconcileWorkerRoutes(
        "workers/foo",
        [makeDecl({ path: "/a" })],
        new Set(),
        "foo",
        singletons
      );
      expect(reg.lookup("/_r/w/workers/foo/a", "GET", false)).not.toBeNull();
      expect(reg.lookup("/_r/w/workers/foo/b", "GET", false)).toBeNull();
    });

    it("skips DO routes whose class is not live", () => {
      const reg = new RouteRegistry();
      const singletons = makeSingletons([
        { source: "workers/foo", className: "Live", key: "live-key" },
        { source: "workers/foo", className: "Dead", key: "dead-key" },
      ]);
      reg.reconcileWorkerRoutes(
        "workers/foo",
        [
          makeDecl({ path: "/live", worker: undefined, durableObject: { className: "Live" } }),
          makeDecl({ path: "/dead", worker: undefined, durableObject: { className: "Dead" } }),
        ],
        new Set(["Live"]),
        null,
        singletons
      );
      expect(reg.lookup("/_r/w/workers/foo/live", "GET", false)).not.toBeNull();
      expect(reg.lookup("/_r/w/workers/foo/dead", "GET", false)).toBeNull();
    });

    it("skips regular routes when canonical instance is absent", () => {
      const reg = new RouteRegistry();
      const singletons = makeSingletons([]);
      reg.reconcileWorkerRoutes(
        "workers/foo",
        [makeDecl({ path: "/x" })],
        new Set(),
        null,
        singletons
      );
      expect(reg.lookup("/_r/w/workers/foo/x", "GET", false)).toBeNull();
    });
  });

  describe("canonicalInstanceName helper", () => {
    it("returns last segment of source", () => {
      expect(canonicalInstanceName("workers/my-worker")).toBe("my-worker");
      expect(canonicalInstanceName("panels/editor")).toBe("editor");
    });
  });
});
