/**
 * RouteRegistry — Worker/service HTTP route dispatch table.
 *
 * Owns the `/_r/` URL namespace served by the gateway (see `gateway.ts`). Two
 * kinds of routes are supported:
 *
 * - **Worker routes** (`/_r/w/<source>/<path>`) — declared in package manifests
 *   (`natstack.routes[]`). Each entry is either DO-backed (`durableObject` set,
 *   dispatched via workerd's `/_w/` router) or bound to the default `fetch` of
 *   a regular worker (the canonical-name instance only).
 *
 * - **Service routes** (`/_r/s/<serviceName>/<path>`) — registered in-process
 *   by server-side service factories that return `{ definition, routes? }`.
 *
 * Registration lifecycles:
 *   - DO routes: registered when a DO class becomes known to workerd
 *     (`workerdManager.registerAllDOClasses`, `onSourceRebuilt`), unregistered
 *     when the DO class is dropped.
 *   - Worker routes: registered at the end of `createRegularInstance` iff the
 *     instance's name equals the canonical name (= source's last segment),
 *     unregistered in `destroyInstance` for the canonical instance.
 *   - Service routes: registered at bootstrap alongside container.register().
 *
 * Gateway consumes `lookup()` to dispatch requests and upgrades; it performs
 * pure URL rewrites for worker routes (to `/_w/...` for DO or `/<instance>/...`
 * for regular) and calls service handlers in-process.
 */

import type { IncomingMessage, ServerResponse } from "http";
import type { Duplex } from "stream";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("RouteRegistry");

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
export type RouteAuth = "public" | "admin-token";

/** Shape declared in a package manifest's `natstack.routes[]` entry. */
export interface ManifestRouteDecl {
  path: string;
  methods?: HttpMethod[];
  durableObject?: { className: string; objectKey?: string };
  auth?: RouteAuth;
  websocket?: boolean;
}

/** Service-owned route (server-local; not shared). */
export interface ServiceRouteDecl {
  serviceName: string;
  path: string;
  methods?: HttpMethod[];
  auth?: RouteAuth;
  websocket?: boolean;
  handler: (
    req: IncomingMessage,
    res: ServerResponse,
    params: Record<string, string>,
  ) => void | Promise<void>;
  onUpgrade?: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    params: Record<string, string>,
  ) => void;
}

interface CompiledPattern {
  regex: RegExp;
  paramNames: string[];
}

interface WorkerRouteEntry {
  kind: "worker-do" | "worker-regular";
  source: string;
  rawPath: string;
  pattern: CompiledPattern;
  methods: Set<HttpMethod>;
  auth: RouteAuth;
  websocket: boolean;
  /** DO-backed only. */
  className?: string;
  objectKey?: string;
  /** Regular-worker only. */
  targetInstanceName?: string;
}

interface ServiceRouteEntry {
  kind: "service";
  serviceName: string;
  rawPath: string;
  pattern: CompiledPattern;
  methods: Set<HttpMethod>;
  auth: RouteAuth;
  websocket: boolean;
  handler: ServiceRouteDecl["handler"];
  onUpgrade: ServiceRouteDecl["onUpgrade"];
}

export type LookupResult =
  | {
      kind: "worker-do";
      source: string;
      className: string;
      objectKey: string;
      remainder: string;
      auth: RouteAuth;
      websocket: boolean;
    }
  | {
      kind: "worker-regular";
      source: string;
      targetInstanceName: string;
      remainder: string;
      auth: RouteAuth;
      websocket: boolean;
    }
  | {
      kind: "service";
      serviceName: string;
      handler: ServiceRouteDecl["handler"];
      onUpgrade: ServiceRouteDecl["onUpgrade"];
      params: Record<string, string>;
      auth: RouteAuth;
      websocket: boolean;
    };

const DEFAULT_METHODS: HttpMethod[] = ["GET", "POST"];

function normalizePath(p: string): string {
  if (!p.startsWith("/")) p = "/" + p;
  // Collapse trailing slash (but keep "/")
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

/**
 * Compile `:param`-style paths to a regex. Supports plain segments and
 * `:name` segments. No wildcards / optional segments in v1.
 */
function compilePattern(rawPath: string): CompiledPattern {
  const path = normalizePath(rawPath);
  const paramNames: string[] = [];
  const segments = path.split("/").filter((s) => s.length > 0);
  const regexParts = segments.map((seg) => {
    if (seg.startsWith(":")) {
      paramNames.push(seg.slice(1));
      return "([^/]+)";
    }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  });
  // Match exact path; for worker routes the caller will pass the "remainder"
  // so we tail-anchor here. An empty path "" → regex "^/?$".
  const body = regexParts.length === 0 ? "/?" : "/" + regexParts.join("/");
  return { regex: new RegExp("^" + body + "/?$"), paramNames };
}

function matchPattern(
  pattern: CompiledPattern,
  path: string,
): Record<string, string> | null {
  const m = pattern.regex.exec(path);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.paramNames.length; i++) {
    params[pattern.paramNames[i]!] = m[i + 1] ?? "";
  }
  return params;
}

export class RouteRegistry {
  /** Keyed by source path (e.g., "workers/my-worker"). */
  private workerRoutes = new Map<string, WorkerRouteEntry[]>();
  /** Keyed by serviceName. */
  private serviceRoutes = new Map<string, ServiceRouteEntry[]>();

  // =========================================================================
  // Worker routes — manifest-declared
  // =========================================================================

  /**
   * Register DO-backed routes for a specific class of a source. Callers may
   * pass the full `manifest.natstack.routes` list; only entries whose
   * `durableObject.className` matches `className` are registered.
   */
  registerDoRoutes(
    source: string,
    className: string,
    routes: ManifestRouteDecl[],
  ): void {
    for (const r of routes) {
      if (!r.durableObject) continue;
      if (r.durableObject.className !== className) continue;
      this.addWorkerEntry(source, {
        kind: "worker-do",
        source,
        rawPath: normalizePath(r.path),
        pattern: compilePattern(r.path),
        methods: new Set(r.methods ?? DEFAULT_METHODS),
        auth: r.auth ?? "public",
        websocket: r.websocket ?? false,
        className: r.durableObject.className,
        objectKey: r.durableObject.objectKey ?? "singleton",
      });
    }
  }

  /**
   * Register regular-worker routes for the canonical instance of a source.
   * Caller must have verified `instanceName === canonicalName(source)`.
   */
  registerWorkerRoutes(
    source: string,
    canonicalInstanceName: string,
    routes: ManifestRouteDecl[],
  ): void {
    for (const r of routes) {
      if (r.durableObject) continue;
      this.addWorkerEntry(source, {
        kind: "worker-regular",
        source,
        rawPath: normalizePath(r.path),
        pattern: compilePattern(r.path),
        methods: new Set(r.methods ?? DEFAULT_METHODS),
        auth: r.auth ?? "public",
        websocket: r.websocket ?? false,
        targetInstanceName: canonicalInstanceName,
      });
    }
  }

  /** Remove all regular-worker routes for a source (canonical instance torn down). */
  unregisterWorkerRoutes(source: string): void {
    const existing = this.workerRoutes.get(source);
    if (!existing) return;
    const remaining = existing.filter((e) => e.kind !== "worker-regular");
    if (remaining.length === 0) this.workerRoutes.delete(source);
    else this.workerRoutes.set(source, remaining);
  }

  /** Remove all DO routes for a source (source removed from build graph). */
  unregisterDoRoutes(source: string, className?: string): void {
    const existing = this.workerRoutes.get(source);
    if (!existing) return;
    const remaining = existing.filter((e) => {
      if (e.kind !== "worker-do") return true;
      if (className && e.className !== className) return true;
      return false;
    });
    if (remaining.length === 0) this.workerRoutes.delete(source);
    else this.workerRoutes.set(source, remaining);
  }

  /** Remove everything for a source. */
  unregisterSource(source: string): void {
    this.workerRoutes.delete(source);
  }

  /**
   * Reconcile a source's manifest routes after a rebuild.
   *
   * Keeps only entries whose (kind, path, className?) matches the new manifest.
   * Caller passes the set of currently-known DO classes and whether the
   * canonical regular-worker instance exists — entries are dropped if their
   * target is no longer live.
   */
  reconcileWorkerRoutes(
    source: string,
    newRoutes: ManifestRouteDecl[],
    liveDoClasses: Set<string>,
    canonicalInstanceName: string | null,
  ): void {
    // Drop all existing entries for this source and rebuild from scratch.
    // **This is safe only because route entries carry no per-registration
    // state** — they're pure (path + methods + auth + target). If a future
    // field lands that's expensive to recompute or holds a DO handle / token
    // tied to a registration, this must become a real diff (keep-matching,
    // unregister-dropped, register-added) to avoid data loss.
    this.workerRoutes.delete(source);
    if (newRoutes.length === 0) return;

    for (const r of newRoutes) {
      if (r.durableObject) {
        if (!liveDoClasses.has(r.durableObject.className)) continue;
        this.addWorkerEntry(source, {
          kind: "worker-do",
          source,
          rawPath: normalizePath(r.path),
          pattern: compilePattern(r.path),
          methods: new Set(r.methods ?? DEFAULT_METHODS),
          auth: r.auth ?? "public",
          websocket: r.websocket ?? false,
          className: r.durableObject.className,
          objectKey: r.durableObject.objectKey ?? "singleton",
        });
      } else {
        if (!canonicalInstanceName) continue;
        this.addWorkerEntry(source, {
          kind: "worker-regular",
          source,
          rawPath: normalizePath(r.path),
          pattern: compilePattern(r.path),
          methods: new Set(r.methods ?? DEFAULT_METHODS),
          auth: r.auth ?? "public",
          websocket: r.websocket ?? false,
          targetInstanceName: canonicalInstanceName,
        });
      }
    }
  }

  getWorkerRoutesBySource(source: string): ReadonlyArray<WorkerRouteEntry> {
    return this.workerRoutes.get(source) ?? [];
  }

  private addWorkerEntry(source: string, entry: WorkerRouteEntry): void {
    const list = this.workerRoutes.get(source) ?? [];
    // Deduplicate by kind + rawPath + (DO: className+objectKey).
    const idx = list.findIndex((e) => {
      if (e.kind !== entry.kind) return false;
      if (e.rawPath !== entry.rawPath) return false;
      if (e.kind === "worker-do" && entry.kind === "worker-do") {
        return e.className === entry.className && e.objectKey === entry.objectKey;
      }
      return true;
    });
    if (idx !== -1) {
      log.warn(
        `Duplicate route registration for ${source} path=${entry.rawPath}; replacing`,
      );
      list[idx] = entry;
    } else {
      list.push(entry);
    }
    this.workerRoutes.set(source, list);
  }

  // =========================================================================
  // Service routes — server-local
  // =========================================================================

  registerService(routes: ServiceRouteDecl[]): void {
    for (const r of routes) {
      const entry: ServiceRouteEntry = {
        kind: "service",
        serviceName: r.serviceName,
        rawPath: normalizePath(r.path),
        pattern: compilePattern(r.path),
        methods: new Set(r.methods ?? DEFAULT_METHODS),
        auth: r.auth ?? "public",
        websocket: r.websocket ?? false,
        handler: r.handler,
        onUpgrade: r.onUpgrade,
      };
      const list = this.serviceRoutes.get(r.serviceName) ?? [];
      const idx = list.findIndex((e) => e.rawPath === entry.rawPath);
      if (idx !== -1) {
        log.warn(
          `Duplicate service-route registration for ${r.serviceName} path=${entry.rawPath}; replacing`,
        );
        list[idx] = entry;
      } else {
        list.push(entry);
      }
      this.serviceRoutes.set(r.serviceName, list);
    }
  }

  unregisterService(serviceName: string): void {
    this.serviceRoutes.delete(serviceName);
  }

  // =========================================================================
  // Lookup
  // =========================================================================

  /**
   * Resolve a `/_r/...` URL + method to a dispatch target.
   * Returns `null` on no-match. Method-mismatch returns `"method-not-allowed"`.
   */
  lookup(
    urlPath: string,
    method: string,
    isUpgrade: boolean,
  ): LookupResult | "method-not-allowed" | null {
    if (!urlPath.startsWith("/_r/")) return null;
    const afterPrefix = urlPath.slice(3); // starts with "/"
    // Peel kind: "/w/..." or "/s/..."
    const segs = afterPrefix.split("/").filter((s) => s.length > 0);
    if (segs.length < 1) return null;

    const kindSeg = segs[0];
    if (kindSeg === "w") {
      // /_r/w/<source0>/<source1>/<path...>
      if (segs.length < 3) return null;
      const source = `${segs[1]}/${segs[2]}`;
      const remainderPath = "/" + segs.slice(3).join("/");
      const entries = this.workerRoutes.get(source);
      if (!entries || entries.length === 0) return null;

      let methodMismatch = false;
      for (const e of entries) {
        const match = matchPattern(e.pattern, remainderPath);
        if (!match) continue;
        if (!isUpgrade && !e.methods.has(method as HttpMethod)) {
          methodMismatch = true;
          continue;
        }
        if (isUpgrade && !e.websocket) continue;
        if (e.kind === "worker-do") {
          return {
            kind: "worker-do",
            source: e.source,
            className: e.className!,
            objectKey: e.objectKey!,
            remainder: remainderPath,
            auth: e.auth,
            websocket: e.websocket,
          };
        }
        return {
          kind: "worker-regular",
          source: e.source,
          targetInstanceName: e.targetInstanceName!,
          remainder: remainderPath,
          auth: e.auth,
          websocket: e.websocket,
        };
      }
      return methodMismatch ? "method-not-allowed" : null;
    }

    if (kindSeg === "s") {
      // /_r/s/<serviceName>/<path...>
      if (segs.length < 2) return null;
      const serviceName = segs[1]!;
      const remainderPath = "/" + segs.slice(2).join("/");
      const entries = this.serviceRoutes.get(serviceName);
      if (!entries || entries.length === 0) return null;

      let methodMismatch = false;
      for (const e of entries) {
        const params = matchPattern(e.pattern, remainderPath);
        if (!params) continue;
        if (!isUpgrade && !e.methods.has(method as HttpMethod)) {
          methodMismatch = true;
          continue;
        }
        if (isUpgrade && !e.websocket) continue;
        return {
          kind: "service",
          serviceName: e.serviceName,
          handler: e.handler,
          onUpgrade: e.onUpgrade,
          params,
          auth: e.auth,
          websocket: e.websocket,
        };
      }
      return methodMismatch ? "method-not-allowed" : null;
    }

    return null;
  }
}

/** The canonical instance name for a source (its last path segment). */
export function canonicalInstanceName(source: string): string {
  return source.split("/").filter(Boolean).pop() ?? source;
}
