import { beforeEach, describe, expect, it } from "vitest";

import { createTestDO } from "@workspace/runtime/worker/test-utils";
import {
  canonicalEntityId,
  type EntityRecord,
} from "../../../packages/shared/src/runtime/entitySpec.js";
import { WorkspaceDO } from "./workspaceDO.js";
import { WorkspaceDOTestable } from "./workspaceDO.testFixture.js";

const SOURCE = "panels/example";
const VERSION = "v1";

function panelInput(overrides: Partial<Parameters<WorkspaceDO["entityActivate"]>[0]> = {}) {
  return {
    kind: "panel" as const,
    source: { repoPath: SOURCE, effectiveVersion: VERSION },
    contextId: "ctx-1",
    key: "entry-1",
    ...overrides,
  };
}

function doInput(overrides: Partial<Parameters<WorkspaceDO["entityActivate"]>[0]> = {}) {
  return {
    kind: "do" as const,
    source: { repoPath: SOURCE, effectiveVersion: VERSION },
    contextId: "ctx-1",
    className: "MyDO",
    key: "k1",
    ...overrides,
  };
}

describe("WorkspaceDO.entityActivate", () => {
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  it("inserts a new active record when no prior row exists", () => {
    const rec = instance.entityActivate(panelInput());
    expect(rec).toMatchObject({
      id: canonicalEntityId({ kind: "panel", key: "entry-1" }),
      kind: "panel",
      status: "active",
      contextId: "ctx-1",
      key: "entry-1",
      cleanupComplete: true,
    });
    expect(rec.retiredAt).toBeUndefined();
  });

  it("is idempotent when called twice with identical identity on an active row", () => {
    const a = instance.entityActivate(panelInput());
    const b = instance.entityActivate(panelInput());
    expect(b.id).toBe(a.id);
    expect(b.status).toBe("active");
    expect(b.createdAt).toBe(a.createdAt);
  });

  it("reactivates a retired row with identical identity", () => {
    const initial = instance.entityActivate(panelInput());
    instance.entityRetire(initial.id);
    const retired = instance.entityResolve(initial.id);
    expect(retired?.status).toBe("retired");
    expect(retired?.retiredAt).toBeTypeOf("number");

    const reactivated = instance.entityActivate(panelInput());
    expect(reactivated.id).toBe(initial.id);
    expect(reactivated.status).toBe("active");
    expect(reactivated.retiredAt).toBeUndefined();
    expect(reactivated.cleanupComplete).toBe(true);
  });

  it("throws IDENTITY_COLLISION when source differs for a panel (canonical id collides on key)", () => {
    // panel canonical id is `panel:<key>` and is source-independent, so two
    // activates with the same key but different sources hit the same row.
    instance.entityActivate(panelInput({ key: "p1" }));
    expect(() =>
      instance.entityActivate({
        kind: "panel",
        source: { repoPath: "panels/other", effectiveVersion: VERSION },
        contextId: "ctx-1",
        key: "p1",
      })
    ).toThrow(/Identity collision/);
  });

  it("throws IDENTITY_COLLISION when effectiveVersion differs for a do (canonical id matches)", () => {
    instance.entityActivate(doInput());
    expect(() =>
      instance.entityActivate(doInput({ source: { repoPath: SOURCE, effectiveVersion: "v2" } }))
    ).toThrow(/Identity collision/);
  });

  it("throws IDENTITY_COLLISION when contextId differs", () => {
    instance.entityActivate(doInput());
    expect(() => instance.entityActivate(doInput({ contextId: "ctx-other" }))).toThrow(
      /Identity collision/
    );
  });

  it("allows stateArgs to change on an idempotent activate", () => {
    instance.entityActivate(doInput({ stateArgs: { a: 1 } }));
    const rec = instance.entityActivate(doInput({ stateArgs: { a: 2 } }));
    expect(rec.stateArgs).toEqual({ a: 1 });
  });
});

describe("WorkspaceDO.entityRetire", () => {
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  it("is idempotent on already-retired rows", () => {
    const rec = instance.entityActivate(panelInput());
    const first = instance.entityRetire(rec.id);
    const second = instance.entityRetire(rec.id);
    expect(first?.status).toBe("retired");
    expect(second?.status).toBe("retired");
    expect(second?.retiredAt).toBe(first?.retiredAt);
  });

  it("returns null when retiring a missing row", () => {
    expect(instance.entityRetire("panel:missing")).toBeNull();
  });
});

describe("WorkspaceDO.entityGc", () => {
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  it("with {all:true, graceMs:0} deletes retired rows", () => {
    const rec = instance.entityActivate(panelInput());
    instance.entityRetire(rec.id);
    const deleted = instance.entityGc({ all: true, graceMs: 0 });
    expect(deleted).toEqual([rec.id]);
    expect(instance.entityResolve(rec.id)).toBeNull();
  });

  it("does not delete active rows", () => {
    const rec = instance.entityActivate(panelInput());
    const deleted = instance.entityGc({ all: true, graceMs: 0 });
    expect(deleted).toEqual([]);
    expect(instance.entityResolve(rec.id)).not.toBeNull();
  });

  it("does not delete retired rows referenced by slot_history", () => {
    const rec = instance.entityActivate(panelInput({ key: "slot-entry" }));
    instance.slotCreate({
      slotId: "slot-A",
      parentSlotId: null,
      positionId: "000001000000",
      initialEntry: {
        entryKey: rec.key,
        entityId: rec.id,
        source: SOURCE,
        contextId: "ctx-1",
      },
    });
    instance.entityRetire(rec.id);
    const deleted = instance.entityGc({ all: true, graceMs: 0 });
    expect(deleted).toEqual([]);
    expect(instance.entityResolve(rec.id)).not.toBeNull();
  });

  it("respects the grace window", () => {
    const rec = instance.entityActivate(panelInput());
    instance.entityRetire(rec.id);
    // graceMs of 10 minutes is far longer than the just-now retirement.
    expect(instance.entityGc({ all: true, graceMs: 10 * 60 * 1000 })).toEqual([]);
    expect(instance.entityResolve(rec.id)).not.toBeNull();
  });
});

describe("WorkspaceDO slot operations", () => {
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  it("round-trips slotCreate / slotAppendHistory / slotSetCurrent / slotHistory", () => {
    const entryA = instance.entityActivate(panelInput({ key: "a" }));
    const entryB = instance.entityActivate(panelInput({ key: "b" }));

    instance.slotCreate({
      slotId: "slot-1",
      parentSlotId: null,
      positionId: "000001000000",
      initialEntry: {
        entryKey: entryA.key,
        entityId: entryA.id,
        source: SOURCE,
        contextId: "ctx-1",
      },
    });
    const cursor = instance.slotAppendHistory("slot-1", {
      entryKey: entryB.key,
      entityId: entryB.id,
      source: SOURCE,
      contextId: "ctx-1",
    });
    expect(cursor).toBe(1);

    instance.slotSetCurrent("slot-1", entryB.key);
    const slot = instance.slotGet("slot-1");
    expect(slot?.current_entry_key).toBe(entryB.key);
    expect(slot?.current_entity_id).toBe(entryB.id);

    const history = instance.slotHistory("slot-1");
    expect(history.map((h) => h.cursor)).toEqual([0, 1]);
    expect(history.map((h) => h.entry_key)).toEqual([entryA.key, entryB.key]);
  });

  it("slotReplaceHistory rewrites history and updates the cursor", () => {
    const e1 = instance.entityActivate(panelInput({ key: "e1" }));
    const e2 = instance.entityActivate(panelInput({ key: "e2" }));
    const e3 = instance.entityActivate(panelInput({ key: "e3" }));
    instance.slotCreate({
      slotId: "slot-r",
      parentSlotId: null,
      positionId: "000001000000",
      initialEntry: {
        entryKey: e1.key,
        entityId: e1.id,
        source: SOURCE,
        contextId: "ctx-1",
      },
    });
    instance.slotReplaceHistory(
      "slot-r",
      [
        { entryKey: e2.key, entityId: e2.id, source: SOURCE, contextId: "ctx-1" },
        { entryKey: e3.key, entityId: e3.id, source: SOURCE, contextId: "ctx-1" },
      ],
      1
    );
    const slot = instance.slotGet("slot-r");
    expect(slot?.current_entry_key).toBe(e3.key);
    expect(instance.slotHistory("slot-r").map((h) => h.entry_key)).toEqual([e2.key, e3.key]);
  });

  it("slotUpdateCurrentStateArgs mutates the current history entry without changing entity id", () => {
    const rec = instance.entityActivate(panelInput({ key: "state-1", stateArgs: { a: 1 } }));
    instance.slotCreate({
      slotId: "slot-state",
      parentSlotId: null,
      positionId: "000001000000",
      initialEntry: {
        entryKey: rec.key,
        entityId: rec.id,
        source: SOURCE,
        contextId: "ctx-1",
        stateArgs: { a: 1 },
      },
    });

    instance.slotUpdateCurrentStateArgs("slot-state", { a: 2 });

    const slot = instance.slotGet("slot-state");
    expect(slot?.current_entity_id).toBe(rec.id);
    expect(instance.slotHistory("slot-state")[0]?.state_args).toBe(JSON.stringify({ a: 2 }));
    expect(instance.entityResolve(rec.id)?.stateArgs).toEqual({ a: 2 });
  });

  it("slotClose marks the slot closed and clears current pointers", () => {
    const rec = instance.entityActivate(panelInput({ key: "close-1" }));
    instance.slotCreate({
      slotId: "slot-c",
      parentSlotId: null,
      positionId: "000001000000",
      initialEntry: {
        entryKey: rec.key,
        entityId: rec.id,
        source: SOURCE,
        contextId: "ctx-1",
      },
    });
    instance.slotClose("slot-c");
    const slot = instance.slotGet("slot-c");
    expect(slot?.closed_at).toBeTypeOf("number");
    expect(slot?.current_entry_key).toBeNull();
  });
});

describe("WorkspaceDO entity reads", () => {
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  it("entityResolveActive returns null after retire and a record while active", () => {
    const rec = instance.entityActivate(panelInput());
    expect(instance.entityResolveActive(rec.id)?.id).toBe(rec.id);
    instance.entityRetire(rec.id);
    expect(instance.entityResolveActive(rec.id)).toBeNull();
  });

  it("entityFindIncompleteCleanups returns retired rows with cleanup_complete=0", () => {
    const r1 = instance.entityActivate(panelInput({ key: "a" }));
    const r2 = instance.entityActivate(panelInput({ key: "b" }));
    instance.entityRetire(r1.id);
    instance.entityRetire(r2.id);
    instance.entityCleanupComplete(r1.id);
    const incomplete = instance.entityFindIncompleteCleanups();
    expect(incomplete.map((r: EntityRecord) => r.id)).toEqual([r2.id]);
  });
});

describe("WorkspaceDO lifecycle registry", () => {
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  it("upserts, refreshes, lists, and clears active-work leases", () => {
    const key = { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" };
    instance.lifecycleLeaseUpsert({ ...key, detail: { turnId: "turn-1" } });
    instance.lifecycleLeaseUpsert({ ...key, detail: { turnId: "turn-2" } });

    expect(instance.lifecycleListLeases()).toMatchObject([
      { ...key, detail: { turnId: "turn-2" } },
    ]);

    instance.lifecycleLeaseClear(key);
    expect(instance.lifecycleListLeases()).toEqual([]);
  });

  it("opens an epoch and snapshots live leases into prepare and resume ops", () => {
    const key = { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" };
    instance.lifecycleLeaseUpsert(key);

    const epochId = instance.lifecycleOpenEpoch({
      kind: "planned",
      reason: "restart",
      generation: 2,
    });
    expect(epochId).toMatch(/^epoch-/);

    const ops = instance.lifecycleListOps(epochId);
    expect(ops).toHaveLength(2);
    expect(ops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ ...key, opKind: "prepare", status: "pending" }),
        expect.objectContaining({ ...key, opKind: "resume", status: "pending" }),
      ])
    );
  });

  it("returns lease-only crash targets even when no epoch or op exists", () => {
    const key = { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" };
    instance.lifecycleLeaseUpsert(key);

    expect(instance.lifecycleListResumeTargets()).toEqual([key]);
  });

  it("includes unfinished resume ops after the lease has been cleared", () => {
    const key = { source: "workers/agent", className: "AiChatWorker", objectKey: "ch-1" };
    instance.lifecycleLeaseUpsert(key);
    const epochId = instance.lifecycleOpenEpoch({
      kind: "planned",
      reason: "restart",
      generation: 2,
    });
    instance.lifecycleLeaseClear(key);

    expect(instance.lifecycleListResumeTargets()).toEqual([key]);

    instance.lifecycleRecordOp({
      epochId,
      key,
      opKind: "resume",
      status: "resumed",
    });
    expect(instance.lifecycleListResumeTargets()).toEqual([]);
  });

  it("clears a DO lease when the matching entity is retired", () => {
    const rec = instance.entityActivate(doInput());
    const key = { source: SOURCE, className: "MyDO", objectKey: "k1" };
    instance.lifecycleLeaseUpsert(key);

    instance.entityRetire(rec.id);

    expect(instance.lifecycleListLeases()).toEqual([]);
  });
});

describe("WorkspaceDO panel search metadata (FTS5-free fallback)", () => {
  // sql.js (the test fixture) lacks FTS5, so the panel_fts virtual table is
  // omitted by WorkspaceDOTestable. These tests cover the metadata-only path
  // that the real FTS5 virtual table reads from; the full search query is
  // covered by the workerd integration test.
  let instance: WorkspaceDO;
  beforeEach(async () => {
    ({ instance } = await createTestDO(WorkspaceDOTestable));
  });

  function readMetadata(slotId: string): Record<string, unknown> | undefined {
    return (
      (
        instance as unknown as {
          sql: { exec(s: string, ...b: unknown[]): { toArray(): unknown[] } };
        }
      ).sql
        .exec(`SELECT * FROM panel_search_metadata WHERE slot_id = ?`, slotId)
        .toArray() as Array<Record<string, unknown>>
    )[0];
  }

  // Helper: stand up an entity + slot pair so the title-flow methods have
  // something to bind to. Returns the entity id (= what
  // `panelIndex`/`panelUpdateTitle` will return when they stamp a title).
  function bindSlotToEntity(slotId: string, entityKey: string): string {
    const entity = instance.entityActivate({
      kind: "panel",
      source: { repoPath: "panels/test", effectiveVersion: "ev-1" },
      contextId: "ctx",
      key: entityKey,
    });
    instance.slotCreate({
      slotId,
      parentSlotId: null,
      positionId: "000001000000",
      initialEntry: {
        entryKey: "entry-1",
        entityId: entity.id,
        source: "panels/test",
        contextId: "ctx",
      },
    });
    return entity.id;
  }

  function readEntityTitle(entityId: string): string | null {
    const sql = (
      instance as unknown as {
        sql: { exec(s: string, ...b: unknown[]): { toArray(): unknown[] } };
      }
    ).sql;
    const row = sql
      .exec(`SELECT display_title FROM entities WHERE id = ?`, entityId)
      .toArray()[0] as { display_title: string | null } | undefined;
    return row?.display_title ?? null;
  }

  it("panelIndex stamps the title onto the slot's current entity, then panelUpdateTitle routes through entitySetDisplayTitle", () => {
    const entityId = bindSlotToEntity("slot-1", "key-1");

    const returned = instance.panelIndex({
      id: "slot-1",
      title: "Initial Title",
      path: "/projects/foo",
      manifestDescription: "test panel",
      tags: ["x", "y"],
      keywords: ["alpha"],
    });
    expect(returned).toBe(entityId);
    expect(readEntityTitle(entityId)).toBe("Initial Title");

    const inserted = readMetadata("slot-1");
    // panel_search_metadata.searchable_title is a documented FTS
    // denormalization of entities.display_title; both should agree.
    expect(inserted).toMatchObject({
      slot_id: "slot-1",
      searchable_title: "Initial Title",
      searchable_path: "/projects/foo",
      manifest_description: "test panel",
      access_count: 0,
    });
    expect(JSON.parse(inserted!["tags"] as string)).toEqual(["x", "y"]);
    expect(JSON.parse(inserted!["keywords"] as string)).toEqual(["alpha"]);

    const renamed = instance.panelUpdateTitle("slot-1", "Renamed Title");
    expect(renamed).toBe(entityId);
    expect(readEntityTitle(entityId)).toBe("Renamed Title");
    // The FTS denormalization on panel_search_metadata moves in lockstep.
    expect(readMetadata("slot-1")?.["searchable_title"]).toBe("Renamed Title");

    instance.panelIncrementAccess("slot-1");
    instance.panelIncrementAccess("slot-1");
    instance.panelIncrementAccess("slot-1");
    expect(readMetadata("slot-1")?.["access_count"]).toBe(3);
  });

  it("entitySetDisplayTitle works for non-panel entities and clears with null/empty", () => {
    const worker = instance.entityActivate({
      kind: "worker",
      source: { repoPath: "workers/agent", effectiveVersion: "ev-1" },
      contextId: "ctx",
      key: "agent-key",
    });
    instance.entitySetDisplayTitle(worker.id, "Agent Title");
    expect(readEntityTitle(worker.id)).toBe("Agent Title");

    instance.entitySetDisplayTitle(worker.id, "");
    expect(readEntityTitle(worker.id)).toBeNull();

    instance.entitySetDisplayTitle(worker.id, "Back");
    instance.entitySetDisplayTitle(worker.id, null);
    expect(readEntityTitle(worker.id)).toBeNull();
  });

  it("entityListDisplayTitles returns only active entities with titles", () => {
    const a = instance.entityActivate({
      kind: "worker",
      source: { repoPath: "workers/a", effectiveVersion: "ev" },
      contextId: "ctx",
      key: "a",
    });
    const b = instance.entityActivate({
      kind: "worker",
      source: { repoPath: "workers/b", effectiveVersion: "ev" },
      contextId: "ctx",
      key: "b",
    });
    instance.entitySetDisplayTitle(a.id, "Alpha");
    // b has no title — it should be absent from the list.
    expect(
      instance
        .entityListDisplayTitles()
        .map((r) => r.id)
        .sort()
    ).toEqual([a.id]);
    // Retired entities drop out.
    instance.entitySetDisplayTitle(b.id, "Bravo");
    instance.entityRetire(b.id);
    expect(
      instance
        .entityListDisplayTitles()
        .map((r) => r.id)
        .sort()
    ).toEqual([a.id]);
  });

  it("panelIndex is idempotent — re-indexing the same slot_id updates in place rather than inserting a duplicate", () => {
    bindSlotToEntity("slot-2", "key-2");
    instance.panelIndex({ id: "slot-2", title: "First" });
    instance.panelIndex({ id: "slot-2", title: "Second", path: "/p" });

    const rows = (
      instance as unknown as { sql: { exec(s: string, ...b: unknown[]): { toArray(): unknown[] } } }
    ).sql
      .exec(`SELECT * FROM panel_search_metadata WHERE slot_id = ?`, "slot-2")
      .toArray() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["searchable_title"]).toBe("Second");
    expect(rows[0]?.["searchable_path"]).toBe("/p");
  });
});
