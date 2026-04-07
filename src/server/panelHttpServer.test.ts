/**
 * Tests for PanelHttpServer routing, build cache, and callback-based flow.
 *
 * These are unit tests for the zero per-panel state server:
 * - extractSourcePath (URL parsing)
 * - contextIdToSubdomain (subdomain derivation)
 * - storeBuild / invalidateBuild (serving cache)
 * - Callback-based flow (listPanels)
 */

import { describe, it, expect } from "vitest";
import { contextIdToSubdomain } from "../../packages/shared/src/panelIdUtils.js";

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
// contextIdToSubdomain
// ---------------------------------------------------------------------------

describe("contextIdToSubdomain", () => {
  it("lowercases and replaces non-alphanumeric chars", () => {
    expect(contextIdToSubdomain("My-Context_123")).toBe("my-context-123");
  });

  it("collapses multiple dashes", () => {
    expect(contextIdToSubdomain("a--b---c")).toBe("a-b-c");
  });

  it("strips leading and trailing dashes", () => {
    expect(contextIdToSubdomain("-abc-")).toBe("abc");
  });

  it("truncates to 63 chars", () => {
    const long = "a".repeat(100);
    expect(contextIdToSubdomain(long).length).toBe(63);
  });

  it("returns 'default' for empty input", () => {
    expect(contextIdToSubdomain("")).toBe("default");
  });

  it("returns 'default' for all-special-char input", () => {
    expect(contextIdToSubdomain("!!!")).toBe("default");
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
    bundlePath: "/tmp/build/bundle.js",
    html: "<html></html>",
    bundle: "console.log('hi')",
    css: "body{}",
    metadata: { entryPoint: "index.tsx", outputSize: 100, buildDuration: 50 },
  } as unknown as import("./buildV2/buildStore.js").BuildResult;

  it("storeBuild caches by source, hasBuild returns true", () => {
    const server = new PanelHttpServer();
    server.storeBuild("panels/my-app", buildResult);
    expect(server.hasBuild("panels/my-app")).toBe(true);
    expect(server.hasBuild("panels/other")).toBe(false);
  });

  it("invalidateBuild removes cached build", () => {
    const server = new PanelHttpServer();
    server.storeBuild("panels/my-app", buildResult);
    server.invalidateBuild("panels/my-app");
    expect(server.hasBuild("panels/my-app")).toBe(false);
  });

  it("storeBuild rejects build without html", () => {
    const server = new PanelHttpServer();
    expect(() => server.storeBuild("panels/x", { ...buildResult, html: "" })).toThrow();
  });

  it("storeBuild rejects build without bundle", () => {
    const server = new PanelHttpServer();
    expect(() => server.storeBuild("panels/x", { ...buildResult, bundle: "" })).toThrow();
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
