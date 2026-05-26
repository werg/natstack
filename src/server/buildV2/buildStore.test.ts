import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { setUserDataPath } from "@natstack/env-paths";

import {
  artifactFilePath,
  get,
  primaryArtifact,
  primaryArtifactFilePath,
  primaryTextArtifactContent,
  put,
  type BuildResult,
} from "./buildStore.js";

function build(overrides: Partial<BuildResult> = {}): BuildResult {
  return {
    dir: "/tmp/build",
    metadata: {
      kind: "worker",
      name: "workers/a",
      ev: "ev-worker",
      sourcemap: false,
      details: { kind: "generic" },
      builtAt: "2026-01-01T00:00:00.000Z",
    },
    artifacts: [
      {
        path: "worker.js",
        role: "primary",
        contentType: "text/javascript; charset=utf-8",
        encoding: "utf8",
        content: "export default {};",
      },
    ],
    ...overrides,
  };
}

function expectedArtifactSetIntegrity(
  entries: Array<{
    path: string;
    role: string;
    contentType: string;
    encoding: string;
    platform?: string;
    integrity?: string | null;
  }>
): string {
  const canonical = entries
    .map((entry) => ({
      path: entry.path,
      role: entry.role,
      contentType: entry.contentType,
      encoding: entry.encoding,
      platform: entry.platform ?? null,
      integrity: entry.integrity ?? null,
    }))
    .sort((a, b) =>
      `${a.path}\0${a.platform ?? ""}`.localeCompare(`${b.path}\0${b.platform ?? ""}`)
    );
  return `sha256-${createHash("sha256").update(JSON.stringify(canonical)).digest("hex")}`;
}

describe("build artifact helpers", () => {
  it("returns the manifest primary artifact content", () => {
    const result = build();

    expect(primaryArtifact(result)).toMatchObject({ path: "worker.js" });
    expect(primaryTextArtifactContent(result)).toBe("export default {};");
    expect(primaryArtifactFilePath(result)).toBe("/tmp/build/worker.js");
  });

  it("fails closed when a text primary artifact is unavailable", () => {
    expect(() => primaryTextArtifactContent(build({ artifacts: [] }))).toThrow(
      /no primary artifact/
    );
    expect(() =>
      primaryTextArtifactContent(
        build({
          artifacts: [
            {
              path: "worker.wasm",
              role: "primary",
              contentType: "application/wasm",
              encoding: "base64",
              content: "AAAA",
            },
          ],
        })
      )
    ).toThrow(/not UTF-8 text/);
  });

  it("rejects unsafe artifact paths when deriving file paths", () => {
    expect(() => artifactFilePath(build(), { path: "../worker.js" })).toThrow(
      /Invalid build artifact path/
    );
    expect(() => artifactFilePath(build(), { path: "/tmp/worker.js" })).toThrow(
      /Invalid build artifact path/
    );
  });

  it("computes artifact integrity from stored bytes instead of trusting caller input", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-build-store-"));
    try {
      setUserDataPath(root);
      const metadata = build().metadata;
      const result = put(
        "build-key",
        {
          entries: [
            {
              path: "worker.js",
              role: "primary",
              contentType: "text/javascript; charset=utf-8",
              encoding: "utf8",
              integrity: "sha256-provider-supplied",
              content: "hello",
            },
          ],
        },
        metadata
      );
      const expected = `sha256-${createHash("sha256").update("hello").digest("hex")}`;

      expect(result.artifacts[0]).toMatchObject({ integrity: expected });
      expect(get("build-key")?.artifacts[0]).toMatchObject({ integrity: expected });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("computes app build integrity from the stored artifact manifest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-build-store-"));
    try {
      setUserDataPath(root);
      const metadata = {
        ...build().metadata,
        kind: "app" as const,
        details: {
          kind: "app" as const,
          target: "react-native" as const,
          integrity: "sha256-provider-supplied",
          rnHostAbi: "rn-host-1",
          provider: null,
        },
      };
      const result = put(
        "app-build-key",
        {
          entries: [
            {
              path: "index.android.bundle",
              role: "primary",
              contentType: "application/javascript; charset=utf-8",
              encoding: "utf8",
              platform: "android",
              content: "android",
            },
            {
              path: "index.ios.bundle",
              role: "primary",
              contentType: "application/javascript; charset=utf-8",
              encoding: "utf8",
              platform: "ios",
              content: "ios",
            },
          ],
        },
        metadata
      );
      const expected = expectedArtifactSetIntegrity(result.artifacts);

      expect(result.metadata.details).toMatchObject({ integrity: expected });
      expect(get("app-build-key")?.metadata.details).toMatchObject({ integrity: expected });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("loads legacy bundle/css/html/assets build directories without an artifact manifest", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-build-store-"));
    try {
      setUserDataPath(root);
      const dir = path.join(root, "builds", "legacy-key");
      fs.mkdirSync(path.join(dir, "assets"), { recursive: true });
      const metadata = {
        ...build().metadata,
        kind: "app" as const,
        details: {
          kind: "app" as const,
          target: "electron" as const,
          integrity: null,
          rnHostAbi: null,
          provider: null,
        },
      };
      fs.writeFileSync(path.join(dir, "metadata.json"), JSON.stringify(metadata));
      fs.writeFileSync(path.join(dir, "bundle.js"), "console.log('legacy');");
      fs.writeFileSync(path.join(dir, "bundle.css"), "body{}");
      fs.writeFileSync(
        path.join(dir, "index.html"),
        '<script type="module" src="./bundle.js"></script>'
      );
      fs.writeFileSync(path.join(dir, "assets", "chunk.js"), "export {};");

      const result = get("legacy-key");

      expect(result?.artifacts.map((artifact) => artifact.path)).toEqual([
        "bundle.js",
        "bundle.css",
        "index.html",
        "assets/chunk.js",
      ]);
      expect(primaryTextArtifactContent(result as BuildResult)).toBe("console.log('legacy');");
      expect(result?.metadata.details).toMatchObject({
        kind: "app",
        integrity: expect.stringMatching(/^sha256-/),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
