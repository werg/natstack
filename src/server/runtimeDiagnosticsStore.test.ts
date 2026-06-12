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

  it("stamps monotonic per-entity seq and resumes exactly via sinceSeq", () => {
    const statePath = tempStatePath();
    const store = new RuntimeDiagnosticsStore({ statePath, entryCapacity: 10, errorCapacity: 10 });

    const sameTimestamp = 1_700_000_000_000;
    for (const message of ["a", "b", "c"]) {
      store.record({
        entityId: "workers/demo",
        kind: "worker",
        level: "info",
        message,
        source: "console",
        timestamp: sameTimestamp,
      });
    }

    const all = store.history("workers/demo");
    expect(all.entries.map((entry) => entry.seq)).toEqual([1, 2, 3]);

    // Timestamp cursor cannot split colliding records; seq cursor can.
    const afterSecond = store.history("workers/demo", { sinceSeq: 2 });
    expect(afterSecond.entries.map((entry) => entry.message)).toEqual(["c"]);

    // Seq continues across reload instead of restarting.
    const reloaded = new RuntimeDiagnosticsStore({
      statePath,
      entryCapacity: 10,
      errorCapacity: 10,
    });
    reloaded.record({
      entityId: "workers/demo",
      kind: "worker",
      level: "info",
      message: "d",
      source: "console",
    });
    const resumed = reloaded.history("workers/demo", { sinceSeq: 3 });
    expect(resumed.entries.map((entry) => entry.message)).toEqual(["d"]);
    expect(resumed.entries[0]?.seq).toBe(4);
  });
});
