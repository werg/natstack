import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { TokenManager } from "@natstack/shared/tokenManager";
import { recoverPersistedDOTokens, DO_STORAGE_SUBPATH } from "./recoverPersistedDOTokens.js";

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Write a SQLite file at `filePath` that mimics what DurableObjectBase
 * leaves on disk: a `state` table with `(key, value)` columns and the
 * KV rows the test wants to seed.
 */
function writeFixtureSqlite(filePath: string, rows: Record<string, string>): void {
  const db = new DatabaseSync(filePath);
  try {
    db.exec("CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const insert = db.prepare("INSERT INTO state (key, value) VALUES (?, ?)");
    for (const [k, v] of Object.entries(rows)) {
      insert.run(k, v);
    }
  } finally {
    db.close();
  }
}

let tmpRoot: string;
let statePath: string;
let storageRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-do-recover-"));
  statePath = path.join(tmpRoot, "state");
  storageRoot = path.join(statePath, DO_STORAGE_SUBPATH);
  fs.mkdirSync(storageRoot, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("recoverPersistedDOTokens", () => {
  it("re-registers (__instanceId, __instanceToken) into TokenManager", () => {
    const classDir = path.join(storageRoot, "workers_pubsub-channel:PubSubChannel");
    fs.mkdirSync(classDir);
    writeFixtureSqlite(path.join(classDir, "abcd1234.sqlite"), {
      __instanceToken: "tok-channel-1",
      __instanceId: "do:workers/pubsub-channel:PubSubChannel:ch-1",
      __objectKey: "ch-1",
    });

    const tm = new TokenManager();
    const summary = recoverPersistedDOTokens(tm, statePath);

    expect(summary.recovered).toBe(1);
    expect(summary.errors).toBe(0);
    expect(tm.validateToken("tok-channel-1")).toEqual({
      callerId: "do:workers/pubsub-channel:PubSubChannel:ch-1",
      callerKind: "worker",
    });
  });

  it("ignores metadata.sqlite — it has no `state` table", () => {
    const classDir = path.join(storageRoot, "workers_agent-worker:AiChatWorker");
    fs.mkdirSync(classDir);
    // metadata.sqlite that workerd writes — empty schema, no state table.
    const db = new DatabaseSync(path.join(classDir, "metadata.sqlite"));
    db.exec("CREATE TABLE workerd_metadata (id INTEGER PRIMARY KEY)");
    db.close();

    const tm = new TokenManager();
    const summary = recoverPersistedDOTokens(tm, statePath);
    expect(summary).toEqual({ recovered: 0, skipped: 0, errors: 0 });
  });

  it("skips files missing __instanceToken or __instanceId without erroring", () => {
    const classDir = path.join(storageRoot, "workers_pubsub-channel:PubSubChannel");
    fs.mkdirSync(classDir);
    writeFixtureSqlite(path.join(classDir, "only-id.sqlite"), {
      __instanceId: "do:foo:Bar:baz",
    });
    writeFixtureSqlite(path.join(classDir, "only-token.sqlite"), {
      __instanceToken: "orphan-token",
    });

    const tm = new TokenManager();
    const summary = recoverPersistedDOTokens(tm, statePath);
    expect(summary.recovered).toBe(0);
    expect(summary.skipped).toBe(2);
    expect(summary.errors).toBe(0);
    expect(tm.validateToken("orphan-token")).toBeNull();
  });

  it("recovers multiple instances across classes in a single pass", () => {
    const dirA = path.join(storageRoot, "workers_a:ClassA");
    const dirB = path.join(storageRoot, "workers_b:ClassB");
    fs.mkdirSync(dirA);
    fs.mkdirSync(dirB);
    writeFixtureSqlite(path.join(dirA, "i1.sqlite"), {
      __instanceToken: "tok-a-1",
      __instanceId: "do:workers/a:ClassA:i1",
    });
    writeFixtureSqlite(path.join(dirA, "i2.sqlite"), {
      __instanceToken: "tok-a-2",
      __instanceId: "do:workers/a:ClassA:i2",
    });
    writeFixtureSqlite(path.join(dirB, "j1.sqlite"), {
      __instanceToken: "tok-b-1",
      __instanceId: "do:workers/b:ClassB:j1",
    });

    const tm = new TokenManager();
    const summary = recoverPersistedDOTokens(tm, statePath);
    expect(summary.recovered).toBe(3);
    expect(tm.validateToken("tok-a-1")?.callerId).toBe("do:workers/a:ClassA:i1");
    expect(tm.validateToken("tok-a-2")?.callerId).toBe("do:workers/a:ClassA:i2");
    expect(tm.validateToken("tok-b-1")?.callerId).toBe("do:workers/b:ClassB:j1");
  });

  it("returns zero counts when no DO storage directory exists", () => {
    fs.rmSync(storageRoot, { recursive: true });
    const tm = new TokenManager();
    const summary = recoverPersistedDOTokens(tm, statePath);
    expect(summary).toEqual({ recovered: 0, skipped: 0, errors: 0 });
  });

  it("counts corrupt .sqlite files as errors but keeps recovering valid siblings", () => {
    const classDir = path.join(storageRoot, "workers_pubsub-channel:PubSubChannel");
    fs.mkdirSync(classDir);
    fs.writeFileSync(path.join(classDir, "bad.sqlite"), Buffer.from("not a sqlite database"));
    writeFixtureSqlite(path.join(classDir, "good.sqlite"), {
      __instanceToken: "tok-good",
      __instanceId: "do:workers/pubsub-channel:PubSubChannel:good",
    });

    const tm = new TokenManager();
    const summary = recoverPersistedDOTokens(tm, statePath);
    expect(summary.recovered).toBe(1);
    expect(summary.errors).toBe(1);
    expect(tm.validateToken("tok-good")).not.toBeNull();
  });
});

describe("TokenManager.registerExistingToken", () => {
  it("refuses to overwrite an existing binding for the same callerId", () => {
    const tm = new TokenManager();
    const fresh = tm.createToken("c1", "worker");
    const ok = tm.registerExistingToken("stale-tok", "c1", "worker");
    expect(ok).toBe(false);
    expect(tm.getToken("c1")).toBe(fresh);
    expect(tm.validateToken("stale-tok")).toBeNull();
  });

  it("refuses to overwrite an existing binding for the same token", () => {
    const tm = new TokenManager();
    tm.registerExistingToken("shared-tok", "c1", "worker");
    const ok = tm.registerExistingToken("shared-tok", "c2", "worker");
    expect(ok).toBe(false);
    expect(tm.validateToken("shared-tok")?.callerId).toBe("c1");
  });

  it("validates a re-registered token like any other", () => {
    const tm = new TokenManager();
    expect(tm.registerExistingToken("recovered", "do:x:Y:z", "worker")).toBe(true);
    expect(tm.validateToken("recovered")).toEqual({
      callerId: "do:x:Y:z",
      callerKind: "worker",
    });
  });
});
