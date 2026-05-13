import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "./index.js";

describe("GadWorkspaceDO immutable persistence", () => {
  it("appends block-level history and materializes Pi messages", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    const head = await call<{
      branchId: string;
      headHistoryHash: string | null;
      headStateHash: string;
    }>("ensureGadBranch", {
      branchId: "branch-1",
      channelId: "channel-1",
      contextId: "context-1",
    });

    const result = await call<{
      headHistoryHash: string;
      headStateHash: string;
      items: Array<{ hash: string }>;
    }>("appendGadHistoryBatch", {
      branchId: head.branchId,
      expectedHeadHash: head.headHistoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        {
          kind: "message_created",
          actor: "user",
          messageId: "msg:0",
          payload: { role: "user", timestamp: 1 },
        },
        {
          kind: "message_block_added",
          actor: "user",
          messageId: "msg:0",
          blockId: "msg:0:block:0",
          payload: { block: { type: "text", text: "make the change" } },
        },
        {
          kind: "message_finalized",
          actor: "user",
          messageId: "msg:0",
          payload: {},
        },
      ],
    });

    expect(result.items).toHaveLength(3);
    expect(result.headHistoryHash).toMatch(/^history:/);
    expect(result.headStateHash).toBe(head.headStateHash);

    const materialized = await call<{ messages: Array<{ role: string; content: unknown }> }>(
      "materializePiMessages",
      { branchId: "branch-1" },
    );
    expect(materialized.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "make the change" }], timestamp: 1 },
    ]);

    const status = await call<Array<{ metric: string; value: number }>>("getStatus");
    expect(status.find((row) => row.metric === "Branches")?.value).toBe(1);
    expect(status.find((row) => row.metric === "History items")?.value).toBe(3);
  });

  it("materializes observed tool result replacements", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-tools" });
    const first = await call<any>("appendGadHistoryBatch", {
      branchId: head.branchId,
      expectedHeadHash: head.headHistoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        {
          kind: "message_created",
          actor: "tool",
          messageId: "msg:1",
          payload: { role: "toolResult", timestamp: 1 },
        },
        {
          kind: "message_block_added",
          actor: "tool",
          messageId: "msg:1",
          blockId: "msg:1:block:0",
          toolCallId: "tool-1",
          payload: { block: { type: "text", text: "dispatched: ask-user" } },
        },
        {
          kind: "message_finalized",
          actor: "tool",
          messageId: "msg:1",
          payload: {},
        },
      ],
    });

    await call("appendGadHistoryBatch", {
      branchId: head.branchId,
      expectedHeadHash: first.headHistoryHash,
      expectedStateHash: first.headStateHash,
      items: [{
        kind: "tool_result_observed",
        actor: "worker",
        messageId: "msg:1",
        toolCallId: "tool-1",
        payload: {
          toolCallId: "tool-1",
          toolName: "ask_user",
          content: [{ type: "text", text: "submitted" }],
          isError: false,
          timestamp: 2,
          summary: "submitted",
        },
      }],
    });

    const materialized = await call<{ messages: Array<Record<string, unknown>> }>(
      "materializePiMessages",
      { branchId: "branch-tools" },
    );
    expect(materialized.messages).toEqual([
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "ask_user",
        content: [{ type: "text", text: "submitted" }],
        timestamp: 2,
        isError: false,
      },
    ]);
  });

  it("enforces head/state CAS and supports O(1) forks", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-1" });
    const append = await call<any>("appendGadHistoryBatch", {
      branchId: head.branchId,
      expectedHeadHash: head.headHistoryHash,
      expectedStateHash: head.headStateHash,
      items: [{ kind: "system_event", actor: "test", payload: { ok: true } }],
    });

    await expect(call("appendGadHistoryBatch", {
      branchId: head.branchId,
      expectedHeadHash: head.headHistoryHash,
      expectedStateHash: head.headStateHash,
      items: [{ kind: "system_event", actor: "test", payload: { stale: true } }],
    })).rejects.toThrow(/head conflict/);

    const beforeHistory = await call<{ rows: Array<unknown> }>("query", "SELECT * FROM gad_history_items", []);
    const fork = await call<any>("forkGadBranch", {
      sourceBranchId: "branch-1",
      newBranchId: "branch-2",
      historyHash: append.headHistoryHash,
    });
    expect(fork.branchId).toBe("branch-2");
    expect(fork.headHistoryHash).toBe(append.headHistoryHash);
    const afterHistory = await call<{ rows: Array<unknown> }>("query", "SELECT * FROM gad_history_items", []);
    expect(afterHistory.rows).toHaveLength(beforeHistory.rows.length);

    const branches = await call<Array<{ id: string }>>("listGadBranches", {});
    expect(branches.map((branch) => branch.id)).toEqual(expect.arrayContaining([
      "branch-1",
      "branch-2",
    ]));
  });

  it("forks projections without copying immutable history", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-a" });
    const append = await call<any>("appendGadHistoryBatch", {
      branchId: "branch-a",
      expectedHeadHash: head.headHistoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        { kind: "message_created", actor: "user", messageId: "msg:0", payload: { role: "user", timestamp: 1 } },
        {
          kind: "message_block_added",
          actor: "user",
          messageId: "msg:0",
          blockId: "msg:0:block:0",
          payload: { block: { type: "text", text: "base" } },
        },
        { kind: "message_finalized", actor: "user", messageId: "msg:0", payload: {} },
      ],
    });
    const beforeHistory = await call<{ rows: Array<unknown> }>("query", "SELECT * FROM gad_history_items", []);

    await call("forkGadBranch", {
      sourceBranchId: "branch-a",
      newBranchId: "branch-b",
      historyHash: append.headHistoryHash,
    });
    const afterForkHistory = await call<{ rows: Array<unknown> }>("query", "SELECT * FROM gad_history_items", []);
    expect(afterForkHistory.rows).toHaveLength(beforeHistory.rows.length);

    const forked = await call<{ messages: Array<{ role: string; content: unknown }> }>(
      "materializePiMessages",
      { branchId: "branch-b" },
    );
    expect(forked.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "base" }], timestamp: 1 },
    ]);

    const forkHead = await call<any>("getGadBranchHead", { branchId: "branch-b" });
    await call("appendGadHistoryBatch", {
      branchId: "branch-b",
      expectedHeadHash: forkHead.headHistoryHash,
      expectedStateHash: forkHead.headStateHash,
      items: [{ kind: "system_event", actor: "test", payload: { forkOnly: true } }],
    });
    const forkRows = await call<{ rows: Array<{ parent_hash: string | null; branch_id: string }> }>(
      "query",
      "SELECT parent_hash, branch_id FROM gad_history_items WHERE branch_id = ? ORDER BY id",
      ["branch-b"],
    );
    expect(forkRows.rows[0]).toEqual({ parent_hash: append.headHistoryHash, branch_id: "branch-b" });
  });

  it("does not expose session columns in gad tables", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const tables = await call<{ rows: Array<{ name: string }> }>(
      "query",
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'gad_%'",
      [],
    );
    expect(tables.rows.map((row) => row.name)).not.toContain("gad_sessions");
    for (const table of tables.rows.map((row) => row.name)) {
      const columns = await call<{ rows: Array<{ name: string }> }>("query", `PRAGMA table_info(${table})`, []);
      expect(columns.rows.map((row) => row.name)).not.toContain("session_id");
    }
  });

  it("stores workspace state as a persistent tree manifest", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-tree" });
    const append = await call<any>("appendGadHistoryBatch", {
      branchId: head.branchId,
      expectedHeadHash: head.headHistoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        {
          kind: "file_observed",
          actor: "test",
          payload: { path: "src/index.ts", contentHash: "blob:index", operation: "write", mode: 0o100644 },
        },
        {
          kind: "file_observed",
          actor: "test",
          payload: { path: "src/lib/util.ts", contentHash: "blob:util", operation: "write", mode: 0o100644 },
        },
        {
          kind: "file_observed",
          actor: "test",
          payload: { path: "README.md", contentHash: "blob:readme", operation: "write", mode: 0o100644 },
        },
      ],
    });

    const files = await call<Array<{ path: string; content_hash: string }>>("listGadBranchFiles", {
      branchId: head.branchId,
    });
    expect(files.map((file) => file.path)).toEqual(["README.md", "src/index.ts", "src/lib/util.ts"]);

    const nested = await call<{ path: string; content_hash: string }>("readGadFileAtState", {
      stateHash: append.headStateHash,
      path: "src/lib/util.ts",
    });
    expect(nested).toMatchObject({ path: "src/lib/util.ts", content_hash: "blob:util" });

    const entries = await call<{ rows: Array<{ parent_hash: string; name: string; entry_kind: string; child_manifest_hash: string | null }> }>(
      "query",
      "SELECT parent_hash, name, entry_kind, child_manifest_hash FROM gad_manifest_entries ORDER BY parent_hash, name",
      [],
    );
    expect(entries.rows).toContainEqual(expect.objectContaining({
      name: "src",
      entry_kind: "dir",
      child_manifest_hash: expect.stringMatching(/^manifest:/),
    }));
    expect(entries.rows).toContainEqual(expect.objectContaining({
      name: "lib",
      entry_kind: "dir",
      child_manifest_hash: expect.stringMatching(/^manifest:/),
    }));
    expect(entries.rows).toContainEqual(expect.objectContaining({
      name: "util.ts",
      entry_kind: "file",
      child_manifest_hash: null,
    }));

    const validation = await call<{ ok: boolean; errors: string[] }>("validateGadHashes", {});
    expect(validation).toEqual({ ok: true, errors: [] });
  });
});
