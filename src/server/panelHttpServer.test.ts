/**
 * Tests for PanelHttpServer routing, build cache, and callback-based flow.
 *
 * These are unit tests for the zero per-panel state server:
 * - extractSourcePath (URL parsing)
 * - storeBuild / invalidateBuild (serving cache)
 * - Callback-based flow (listPanels)
 */

import { describe, it, expect } from "vitest";
import type { IncomingMessage, ServerResponse } from "http";

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

function createMockResponse(): ServerResponse & {
  body?: unknown;
  statusCodeWritten?: number;
} {
  const res = {
    headersSent: false,
  } as unknown as ServerResponse & {
    body?: unknown;
    statusCodeWritten?: number;
    headersSent: boolean;
  };
  res.setHeader = vi.fn() as unknown as ServerResponse["setHeader"];
  res.writeHead = vi.fn((statusCode: number) => {
    res.headersSent = true;
    res.statusCodeWritten = statusCode;
    return res;
  }) as unknown as ServerResponse["writeHead"];
  res.end = vi.fn((body?: unknown) => {
    res.body = body;
    return res;
  }) as unknown as ServerResponse["end"];
  return res;
}

async function handlePanelRequest(
  server: InstanceType<typeof PanelHttpServer>,
  url: string,
  headers: Record<string, string> = {}
): Promise<ReturnType<typeof createMockResponse>> {
  const req = {
    method: "GET",
    url,
    headers,
  } as unknown as IncomingMessage;
  const res = createMockResponse();
  await (
    server as unknown as {
      handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void>;
    }
  ).handleRequest(req, res);
  return res;
}

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

  it("does not synthesize build refs from panel context ids", async () => {
    const server = new PanelHttpServer();
    server.setPort(1234);
    const getBuild = vi.fn(async () => buildResult);
    server.setCallbacks({
      listPanels: vi.fn().mockReturnValue([]),
      onBuildComplete: vi.fn(),
      getBuild,
    });

    await handlePanelRequest(
      server,
      "/panels/my-app/?contextId=ctx-panel-tree-panels-chat-mqcv4k57-8e395774"
    );

    expect(getBuild).toHaveBeenCalledWith("panels/my-app", undefined);
  });

  it("uses explicit panel build refs when present", async () => {
    const server = new PanelHttpServer();
    server.setPort(1234);
    const getBuild = vi.fn(async () => buildResult);
    server.setCallbacks({
      listPanels: vi.fn().mockReturnValue([]),
      onBuildComplete: vi.fn(),
      getBuild,
    });

    await handlePanelRequest(server, "/panels/my-app/?contextId=ctx-panel&ref=state:abc123");

    expect(getBuild).toHaveBeenCalledWith("panels/my-app", "state:abc123");
  });

  it("does not serve a main entry artifact for a referer-less ref-pinned asset path", async () => {
    const server = new PanelHttpServer();
    const mainBuild = {
      ...buildResult,
      artifacts: buildResult.artifacts.map((artifact) =>
        artifact.role === "primary"
          ? { ...artifact, path: "bundle-main.js", content: "console.log('main')" }
          : artifact
      ),
    } as typeof buildResult;
    const refBuild = {
      ...buildResult,
      artifacts: buildResult.artifacts.map((artifact) =>
        artifact.role === "primary"
          ? { ...artifact, path: "bundle-ref.js", content: "console.log('ref')" }
          : artifact
      ),
    } as typeof buildResult;

    server.storeBuild("panels/my-app", mainBuild);
    server.storeBuild("panels/my-app", refBuild, "state:abc123");

    const refererless = await handlePanelRequest(server, "/panels/my-app/bundle-ref.js");
    expect(refererless.statusCodeWritten).toBe(404);
    expect(refererless.body).toBe("Not found");

    const pinned = await handlePanelRequest(server, "/panels/my-app/bundle-ref.js", {
      referer: "http://localhost:1234/panels/my-app/?ref=state:abc123",
    });
    expect(pinned.statusCodeWritten).toBe(200);
    expect(pinned.body).toBe("console.log('ref')");
  });
});
