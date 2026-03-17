import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { PanelSnapshot } from "../shared/types.js";
import { syncSnapshotFromManifest } from "./panelView.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

function makeSnapshot(overrides?: Partial<PanelSnapshot>): PanelSnapshot {
  return {
    source: "about/new",
    contextId: "ctx-1",
    options: {},
    ...overrides,
  };
}

/** Write a minimal panel package.json with the given natstack manifest fields. */
function writeManifest(
  source: string,
  natstack: Record<string, unknown>,
): void {
  const dir = path.join(tmpDir, source);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: `@test/${source.replace("/", "-")}`,
      version: "0.1.0",
      natstack: { title: "Test", type: "app", ...natstack },
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncSnapshotFromManifest", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "panelview-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("clears autoArchiveWhenEmpty when navigating to a source without the flag", () => {
    writeManifest("panels/chat", {});
    const snapshot = makeSnapshot({ autoArchiveWhenEmpty: true });

    syncSnapshotFromManifest(snapshot, "panels/chat", tmpDir);

    expect(snapshot.autoArchiveWhenEmpty).toBeUndefined();
  });

  it("preserves autoArchiveWhenEmpty when navigating to a source that has it", () => {
    writeManifest("about/help", { autoArchiveWhenEmpty: true });
    const snapshot = makeSnapshot({ autoArchiveWhenEmpty: true });

    syncSnapshotFromManifest(snapshot, "about/help", tmpDir);

    expect(snapshot.autoArchiveWhenEmpty).toBe(true);
  });

  it("sets autoArchiveWhenEmpty when navigating to a source that has it from one that doesn't", () => {
    writeManifest("about/new", { autoArchiveWhenEmpty: true });
    const snapshot = makeSnapshot(); // no autoArchiveWhenEmpty

    syncSnapshotFromManifest(snapshot, "about/new", tmpDir);

    expect(snapshot.autoArchiveWhenEmpty).toBe(true);
  });

  it("clears autoArchiveWhenEmpty when manifest cannot be loaded", () => {
    // No manifest written — simulates browser panel or missing source
    const snapshot = makeSnapshot({ autoArchiveWhenEmpty: true });

    syncSnapshotFromManifest(snapshot, "nonexistent/panel", tmpDir);

    expect(snapshot.autoArchiveWhenEmpty).toBeUndefined();
  });

  it("is a no-op when source has no flag and snapshot has no flag", () => {
    writeManifest("panels/editor", {});
    const snapshot = makeSnapshot();
    delete snapshot.autoArchiveWhenEmpty;

    syncSnapshotFromManifest(snapshot, "panels/editor", tmpDir);

    expect(snapshot.autoArchiveWhenEmpty).toBeUndefined();
    expect("autoArchiveWhenEmpty" in snapshot).toBe(false);
  });
});
