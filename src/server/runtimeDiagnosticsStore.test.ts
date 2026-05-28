import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { RuntimeDiagnosticsStore } from "./runtimeDiagnosticsStore.js";

function tempStatePath(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "natstack-runtime-diagnostics-"));
}

describe("RuntimeDiagnosticsStore", () => {
  it("persists bounded diagnostics with a separate error buffer", () => {
    const statePath = tempStatePath();
    const store = new RuntimeDiagnosticsStore({
      statePath,
      entryCapacity: 2,
      errorCapacity: 2,
    });

    store.record({
      entityId: "do:workers/agent:AgentDO:key",
      kind: "do",
      level: "info",
      message: "first",
      source: "console",
    });
    store.record({
      entityId: "do:workers/agent:AgentDO:key",
      kind: "do",
      level: "error",
      message: "boom-1",
      source: "console",
    });
    store.record({
      entityId: "do:workers/agent:AgentDO:key",
      kind: "do",
      level: "error",
      message: "boom-2",
      source: "console",
    });

    const reloaded = new RuntimeDiagnosticsStore({
      statePath,
      entryCapacity: 2,
      errorCapacity: 2,
    });
    const history = reloaded.history("do:workers/agent:AgentDO:key");

    expect(history.entries.map((entry) => entry.message)).toEqual(["boom-1", "boom-2"]);
    expect(history.errors.map((entry) => entry.message)).toEqual(["boom-1", "boom-2"]);
    expect(history.dropped).toEqual({ entries: 1, errors: 0 });
    expect(history.capacity).toEqual({ entries: 2, errors: 2 });
  });

  it("filters by minimum level and keeps error history independent", () => {
    const store = new RuntimeDiagnosticsStore({
      statePath: tempStatePath(),
      entryCapacity: 5,
      errorCapacity: 5,
    });

    store.record({
      entityId: "extensions/file-tools",
      kind: "extension",
      level: "debug",
      message: "debug",
      source: "ctx.log",
    });
    store.record({
      entityId: "extensions/file-tools",
      kind: "extension",
      level: "warn",
      message: "warn",
      source: "ctx.log",
    });
    store.record({
      entityId: "extensions/file-tools",
      kind: "extension",
      level: "error",
      message: "error",
      source: "ctx.log",
    });

    const history = store.history("extensions/file-tools", { level: "warn" });

    expect(history.entries.map((entry) => entry.message)).toEqual(["warn", "error"]);
    expect(history.errors.map((entry) => entry.message)).toEqual(["error"]);
  });
});
