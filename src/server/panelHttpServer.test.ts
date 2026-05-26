/**
 * Tests for PanelHttpServer routing, build cache, and callback-based flow.
 *
 * These are unit tests for the zero per-panel state server:
 * - extractSourcePath (URL parsing)
 * - storeBuild / invalidateBuild (serving cache)
 * - Callback-based flow (listPanels)
 */

import { describe, it, expect } from "vitest";

// ---------------------------------------------------------------------------
// extractSourcePath is module-private, so we test the regex logic directly.
// ---------------------------------------------------------------------------

function extractSourcePath(pathname: string): { source: string; resource: string } | null {
  const match = pathname.match(/^\/([^/]+\/[^/]+)(\/.*)?$/);
  if (!match) return null;
  return { source: match[1]!, resource: match[2] || "/" };
}

describe("extractSourcePath", () => {
  it("parses two-segment source with trailing slash", () => {
    expect(extractSourcePath("/panels/my-app/")).toEqual({
      source: "panels/my-app",
      resource: "/",
    });
  });

  it("parses two-segment source without trailing slash", () => {
    expect(extractSourcePath("/panels/my-app")).toEqual({
      source: "panels/my-app",
      resource: "/",
    });
  });

  it("parses source with resource path", () => {
    expect(extractSourcePath("/panels/my-app/bundle.js")).toEqual({
      source: "panels/my-app",
      resource: "/bundle.js",
    });
  });

  it("parses source with nested resource path", () => {
    expect(extractSourcePath("/panels/my-app/assets/style.css")).toEqual({
      source: "panels/my-app",
      resource: "/assets/style.css",
    });
  });

  it("parses shell source (about/about format)", () => {
    expect(extractSourcePath("/about/about/")).toEqual({
      source: "about/about",
      resource: "/",
    });
  });

  it("returns null for single-segment path", () => {
    expect(extractSourcePath("/bundle.js")).toBeNull();
  });

  it("returns null for root path", () => {
    expect(extractSourcePath("/")).toBeNull();
  });

  it("returns null for empty path", () => {
    expect(extractSourcePath("")).toBeNull();
  });

  it("rejects colon-based single-segment path", () => {
    expect(extractSourcePath("/shell:about/")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// PanelHttpServer unit tests (zero per-panel state)
// ---------------------------------------------------------------------------

import { vi } from "vitest";

vi.mock("fs", () => ({
  readFileSync: vi.fn().mockReturnValue("// stub"),
  existsSync: vi.fn().mockReturnValue(false),
}));

vi.mock("ws", () => ({
  WebSocketServer: vi.fn().mockImplementation(() => ({
    on: vi.fn(),
    close: vi.fn(),
  })),
}));

// Must import after mocks
const { PanelHttpServer } = await import("./panelHttpServer.js");

describe("PanelHttpServer build cache", () => {
  const buildResult = {
    dir: "/tmp/build",
    artifacts: [
      {
        path: "index.html",
        role: "html",
        contentType: "text/html; charset=utf-8",
        encoding: "utf8",
        content: "<html></html>",
      },
      {
        path: "bundle.js",
        role: "primary",
        contentType: "application/javascript; charset=utf-8",
        encoding: "utf8",
        content: "console.log('hi')",
      },
      {
        path: "bundle.css",
        role: "css",
        contentType: "text/css; charset=utf-8",
        encoding: "utf8",
        content: "body{}",
      },
    ],
    metadata: { entryPoint: "index.tsx", outputSize: 100, buildDuration: 50 },
  } as unknown as import("./buildV2/buildStore.js").BuildResult;

  it("storeBuild caches by source, hasBuild returns true", () => {
    const server = new PanelHttpServer();
    server.storeBuild("panels/my-app", buildResult);
    expect(server.hasBuild("panels/my-app")).toBe(true);
    expect(server.hasBuild("panels/other")).toBe(false);
  });

  it("keys cached builds by ref", () => {
    const server = new PanelHttpServer();
    server.storeBuild("panels/my-app", buildResult, "main");
    expect(server.hasBuild("panels/my-app")).toBe(false);
    expect(server.hasBuild("panels/my-app", "main")).toBe(true);
    expect(server.hasBuild("panels/my-app", "feature")).toBe(false);
  });

  it("assigns monotonically increasing build revisions by cache entry", () => {
    const server = new PanelHttpServer();
    server.storeBuild("panels/my-app", buildResult);
    const firstRevision = server.getBuildRevision("panels/my-app");
    server.storeBuild("panels/my-app", buildResult, "feature");
    const secondRevision = server.getBuildRevision("panels/my-app", "feature");

    expect(firstRevision).toBeGreaterThan(0);
    expect(secondRevision).toBeGreaterThan(firstRevision ?? 0);
    expect(server.getBuildRevision("panels/other")).toBeUndefined();
  });

  it("invalidateBuild removes cached build", () => {
    const server = new PanelHttpServer();
    server.storeBuild("panels/my-app", buildResult);
    server.storeBuild("panels/my-app", buildResult, "feature");
    server.invalidateBuild("panels/my-app");
    expect(server.hasBuild("panels/my-app")).toBe(false);
    expect(server.hasBuild("panels/my-app", "feature")).toBe(false);
  });

  it("storeBuild rejects build without html", () => {
    const server = new PanelHttpServer();
    expect(() =>
      server.storeBuild("panels/x", {
        ...buildResult,
        artifacts: buildResult.artifacts.filter((artifact) => artifact.role !== "html"),
      })
    ).toThrow(/missing HTML or primary artifact/);
  });

  it("storeBuild rejects build without bundle", () => {
    const server = new PanelHttpServer();
    expect(() =>
      server.storeBuild("panels/x", {
        ...buildResult,
        artifacts: buildResult.artifacts.filter((artifact) => artifact.role !== "primary"),
      })
    ).toThrow(/missing HTML or primary artifact/);
  });

  it("storeBuild calls onBuildComplete callback with source", () => {
    const server = new PanelHttpServer();
    const onBuildComplete = vi.fn();
    server.setCallbacks({
      listPanels: vi.fn().mockReturnValue([]),
      onBuildComplete,
      getBuild: vi.fn(),
    });

    server.storeBuild("panels/my-app", buildResult);
    expect(onBuildComplete).toHaveBeenCalledWith("panels/my-app");
  });
});
