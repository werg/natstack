import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "./index.js";

describe("GadWorkspaceDO immutable persistence", () => {
  it("appends block-level trajectory and materializes Pi messages", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);

    const head = await call<{
      branchId: string;
      headTrajectoryHash: string | null;
      headStateHash: string;
    }>("ensureGadBranch", {
      branchId: "branch-1",
      channelId: "channel-1",
      contextId: "context-1",
    });

    const result = await call<{
      headTrajectoryHash: string;
      headStateHash: string;
      items: Array<{ hash: string }>;
    }>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
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
    expect(result.headTrajectoryHash).toMatch(/^trajectory:/);
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
    expect(status.find((row) => row.metric === "Trajectory items")?.value).toBe(3);
  });

  it("materializes observed tool result replacements", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-tools" });
    const first = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
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

    await call("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: first.headTrajectoryHash,
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

  it("reconstructs orphan and duplicate tool call provenance and reports integrity errors", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-tool-integrity" });
    await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        {
          kind: "tool_result_observed",
          actor: "tool",
          toolCallId: "orphan-tool",
          payload: {
            toolCallId: "orphan-tool",
            toolName: "read",
            summary: "observed without request",
            isError: false,
          },
        },
        {
          kind: "tool_call_requested",
          actor: "assistant",
          toolCallId: "dup-tool",
          payload: { toolName: "read", parameters: { path: "a.txt" } },
        },
        {
          kind: "tool_call_requested",
          actor: "assistant",
          toolCallId: "dup-tool",
          payload: { toolName: "read", parameters: { path: "b.txt" } },
        },
      ],
    });

    const calls = await call<Array<Record<string, unknown>>>("listGadBranchToolCalls", {
      branchId: "branch-tool-integrity",
    });
    expect(calls.find((row) => row.tool_call_id === "orphan-tool")).toMatchObject({
      status: "complete",
      result_summary: "observed without request",
    });

    const integrity = await call<{ ok: boolean; errors: Array<{ code: string; toolCallId?: string }> }>(
      "checkGadIntegrity",
      { branchId: "branch-tool-integrity" },
    );
    expect(integrity.ok).toBe(false);
    expect(integrity.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "tool_result_without_request", toolCallId: "orphan-tool" }),
      expect.objectContaining({ code: "duplicate_tool_request", toolCallId: "dup-tool" }),
    ]));
  });

  it("materializes a cold-start LLM prefix from canonical trajectory payloads", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-prefix" });
    await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        {
          kind: "message_created",
          actor: "user",
          messageId: "msg:0",
          payload: {
            role: "user",
            timestamp: 10,
            messageIndex: 0,
            details: { source: "panel" },
          },
        },
        {
          kind: "message_block_added",
          actor: "user",
          messageId: "msg:0",
          blockId: "msg:0:block:0",
          payload: {
            blockIndex: 0,
            block: { type: "text", text: "please inspect the repo" },
          },
        },
        {
          kind: "message_finalized",
          actor: "user",
          messageId: "msg:0",
          payload: {},
        },
        {
          kind: "message_created",
          actor: "assistant",
          messageId: "msg:1",
          payload: { role: "assistant", timestamp: 20, messageIndex: 1 },
        },
        {
          kind: "message_block_added",
          actor: "assistant",
          messageId: "msg:1",
          blockId: "msg:1:block:0",
          toolCallId: "tool-1",
          payload: {
            blockIndex: 0,
            block: { type: "toolCall", id: "tool-1", name: "read", input: { path: "README.md" } },
          },
        },
        {
          kind: "message_block_added",
          actor: "assistant",
          messageId: "msg:1",
          blockId: "msg:1:block:1",
          payload: {
            blockIndex: 1,
            block: { type: "text", text: "I will inspect README.md." },
          },
        },
        {
          kind: "message_finalized",
          actor: "assistant",
          messageId: "msg:1",
          payload: { stopReason: "tool_calls", errorMessage: null },
        },
        {
          kind: "tool_result_observed",
          actor: "tool",
          toolCallId: "tool-1",
          payload: {
            toolCallId: "tool-1",
            toolName: "read",
            content: [{ type: "text", text: "README contents" }],
            details: { path: "README.md" },
            isError: false,
            timestamp: 30,
            summary: "README contents",
          },
        },
      ],
    });

    const materialized = await call<{ messages: Array<Record<string, unknown>> }>(
      "materializePiMessages",
      { branchId: "branch-prefix" },
    );
    expect(materialized.messages).toEqual([
      {
        role: "user",
        content: [{ type: "text", text: "please inspect the repo" }],
        timestamp: 10,
        details: { source: "panel" },
      },
      {
        role: "assistant",
        content: [
          { type: "toolCall", id: "tool-1", name: "read", input: { path: "README.md" } },
          { type: "text", text: "I will inspect README.md." },
        ],
        timestamp: 20,
        stopReason: "tool_calls",
      },
      {
        role: "toolResult",
        toolCallId: "tool-1",
        toolName: "read",
        content: [{ type: "text", text: "README contents" }],
        timestamp: 30,
        details: { path: "README.md" },
        isError: false,
      },
    ]);
  });

  it("enforces head/state CAS and forks by moving a branch ref", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-1" });
    const append = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{ kind: "system_event", actor: "test", payload: { ok: true } }],
    });

    await expect(call("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{ kind: "system_event", actor: "test", payload: { stale: true } }],
    })).rejects.toThrow(/head conflict/);

    const beforeTrajectory = await call<{ rows: Array<unknown> }>("query", "SELECT * FROM gad_trajectory_items", []);
    const fork = await call<any>("forkGadBranch", {
      sourceBranchId: "branch-1",
      newBranchId: "branch-2",
      trajectoryHash: append.headTrajectoryHash,
    });
    expect(fork.branchId).toBe("branch-2");
    expect(fork.headTrajectoryHash).toBe(append.headTrajectoryHash);
    const afterTrajectory = await call<{ rows: Array<unknown> }>("query", "SELECT * FROM gad_trajectory_items", []);
    expect(afterTrajectory.rows).toHaveLength(beforeTrajectory.rows.length);

    const branches = await call<Array<{ id: string }>>("listGadBranches", {});
    expect(branches.map((branch) => branch.id)).toEqual(expect.arrayContaining([
      "branch-1",
      "branch-2",
    ]));
  });

  it("forks by recursive ancestry without copying trajectory rows", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-a" });
    const append = await call<any>("appendGadTrajectoryBatch", {
      branchId: "branch-a",
      expectedTrajectoryHash: head.headTrajectoryHash,
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
    const beforeTrajectory = await call<{ rows: Array<unknown> }>("query", "SELECT * FROM gad_trajectory_items", []);

    await call("forkGadBranch", {
      sourceBranchId: "branch-a",
      newBranchId: "branch-b",
      trajectoryHash: append.headTrajectoryHash,
    });
    const afterForkTrajectory = await call<{ rows: Array<unknown> }>("query", "SELECT * FROM gad_trajectory_items", []);
    expect(afterForkTrajectory.rows).toHaveLength(beforeTrajectory.rows.length);

    const forked = await call<{ messages: Array<{ role: string; content: unknown }> }>(
      "materializePiMessages",
      { branchId: "branch-b" },
    );
    expect(forked.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "base" }], timestamp: 1 },
    ]);

    const forkHead = await call<any>("getGadBranchHead", { branchId: "branch-b" });
    await call("appendGadTrajectoryBatch", {
      branchId: "branch-b",
      expectedTrajectoryHash: forkHead.headTrajectoryHash,
      expectedStateHash: forkHead.headStateHash,
      items: [{ kind: "system_event", actor: "test", payload: { forkOnly: true } }],
    });
    const forkTrajectory = await call<Array<{ kind: string; introduced_on_branch_id: string }>>(
      "listGadBranchTrajectory",
      { branchId: "branch-b", limit: 10 },
    );
    expect(forkTrajectory.map((row) => row.kind).reverse()).toEqual([
      "message_created",
      "message_block_added",
      "message_finalized",
      "system_event",
    ]);
    expect(new Set(forkTrajectory.map((row) => row.introduced_on_branch_id))).toEqual(new Set(["branch-a", "branch-b"]));
    const forkRows = await call<{ rows: Array<{ parent_hash: string | null; introduced_on_branch_id: string }> }>(
      "query",
      "SELECT parent_hash, introduced_on_branch_id FROM gad_trajectory_items WHERE introduced_on_branch_id = ? ORDER BY id",
      ["branch-b"],
    );
    expect(forkRows.rows[0]).toEqual({ parent_hash: append.headTrajectoryHash, introduced_on_branch_id: "branch-b" });
  });

  it("forks from the middle of a trajectory and scopes inherited history recursively", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "main" });
    const append = await call<any>("appendGadTrajectoryBatch", {
      branchId: "main",
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        { kind: "system_event", actor: "test", payload: { step: 1 } },
        { kind: "system_event", actor: "test", payload: { step: 2 } },
        { kind: "system_event", actor: "test", payload: { step: 3 } },
        { kind: "system_event", actor: "test", payload: { step: 4 } },
        { kind: "system_event", actor: "test", payload: { step: 5 } },
      ],
    });
    const beforeRows = await call<{ rows: Array<unknown> }>("query", "SELECT * FROM gad_trajectory_items", []);
    const forkPoint = append.items[2].hash;

    const fork = await call<any>("forkGadBranch", {
      sourceBranchId: "main",
      newBranchId: "child",
      trajectoryHash: forkPoint,
    });
    expect(fork.headTrajectoryHash).toBe(forkPoint);
    const afterForkRows = await call<{ rows: Array<unknown> }>("query", "SELECT * FROM gad_trajectory_items", []);
    expect(afterForkRows.rows).toHaveLength(beforeRows.rows.length);

    await call("appendGadTrajectoryBatch", {
      branchId: "child",
      expectedTrajectoryHash: fork.headTrajectoryHash,
      expectedStateHash: fork.headStateHash,
      items: [{ kind: "system_event", actor: "test", payload: { child: true } }],
    });
    const childTrajectory = await call<Array<{ trajectory_hash: string; kind: string; introduced_on_branch_id: string }>>(
      "listGadBranchTrajectory",
      { branchId: "child", limit: 10 },
    );
    expect(childTrajectory.map((row) => row.trajectory_hash).reverse()).toEqual([
      append.items[0].hash,
      append.items[1].hash,
      append.items[2].hash,
      expect.stringMatching(/^trajectory:/),
    ]);
    expect(new Set(childTrajectory.map((row) => row.introduced_on_branch_id))).toEqual(new Set(["main", "child"]));
  });

  it("scopes state producers across forked branches", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "main-state" });
    const mainMutation = await call<any>("appendGadTrajectoryBatch", {
      branchId: "main-state",
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{
        kind: "file_observed",
        actor: "main",
        payload: { path: "state.txt", contentHash: "blob:main", operation: "write", mode: 0o100644 },
      }],
    });
    const child = await call<any>("forkGadBranch", {
      sourceBranchId: "main-state",
      newBranchId: "child-state",
      trajectoryHash: mainMutation.headTrajectoryHash,
    });
    const mainProducer = await call<Record<string, unknown>>("getGadStateProducer", {
      stateHash: mainMutation.headStateHash,
      branchId: "main-state",
    });
    const childInheritedProducer = await call<Record<string, unknown>>("getGadStateProducer", {
      stateHash: mainMutation.headStateHash,
      branchId: "child-state",
    });
    expect(childInheritedProducer?.trajectory_id).toBe(mainProducer?.trajectory_id);

    const childMutation = await call<any>("appendGadTrajectoryBatch", {
      branchId: "child-state",
      expectedTrajectoryHash: child.headTrajectoryHash,
      expectedStateHash: child.headStateHash,
      items: [{
        kind: "file_mutation",
        actor: "child",
        payload: { path: "state.txt", contentHash: "blob:child", operation: "write", mode: 0o100644 },
      }],
    });
    expect(await call("getGadStateProducer", {
      stateHash: childMutation.headStateHash,
      branchId: "main-state",
    })).toBeNull();
    expect(await call<Record<string, unknown>>("getGadStateProducer", {
      stateHash: childMutation.headStateHash,
      branchId: "child-state",
    })).toMatchObject({ actor: "child" });
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

  it("does not expose legacy compatibility tables", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const objects = await call<{ rows: Array<{ name: string }> }>(
      "query",
      "SELECT name FROM sqlite_master WHERE name IN ('gad_history_items', 'gad_branch_history_view', 'gad_branch_trajectory_view', 'gad_branch_trajectory_items', 'gad_tool_calls', 'gad_tool_calls_view', 'pi_messages_view', 'pi_message_blocks_view', 'gad_pi_messages', 'gad_pi_message_blocks', 'gad_file_activity', 'gad_file_activity_view', 'gad_file_blame_segments')",
      [],
    );
    expect(objects.rows).toEqual([]);
  });

  it("stores workspace state as a persistent tree manifest", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-tree" });
    const append = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
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

    const producer = await call<Record<string, unknown>>("getGadStateProducer", {
      stateHash: append.headStateHash,
      branchId: head.branchId,
    });
    expect(producer).toMatchObject({
      output_state_hash: append.headStateHash,
      kind: "file_observed",
    });

    const blame = await call<Array<Record<string, unknown>>>("blameGadFileSnippet", {
      stateHash: append.headStateHash,
      path: "src/lib/util.ts",
      startLine: 1,
      endLine: 1,
    });
    expect(blame[0]).toMatchObject({
      path: "src/lib/util.ts",
      kind: "file_observed",
    });

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

  it("does not assign output state or sidecars to no-op mutating actions", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-noop" });
    const initial = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{
        kind: "file_observed",
        actor: "test",
        payload: { path: "same.txt", contentHash: "blob:same", operation: "write", mode: 0o100644 },
      }],
    });
    const noop = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: initial.headTrajectoryHash,
      expectedStateHash: initial.headStateHash,
      items: [{
        kind: "file_mutation",
        actor: "test",
        payload: { path: "same.txt", contentHash: "blob:same", operation: "write", mode: 0o100644 },
      }],
    });

    expect(noop.headStateHash).toBe(initial.headStateHash);
    expect(noop.items[0]).toMatchObject({
      inputStateHash: initial.headStateHash,
      outputStateHash: null,
    });
    const rows = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      `SELECT ti.output_state_hash, st.id AS transition_id, h.id AS hunk_id
       FROM gad_trajectory_items ti
       LEFT JOIN gad_state_transitions st ON st.workspace_id = ti.workspace_id AND st.trajectory_id = ti.id
       LEFT JOIN gad_file_change_hunks h ON h.workspace_id = ti.workspace_id AND h.trajectory_id = ti.id
       WHERE ti.hash = ?`,
      [noop.headTrajectoryHash],
    );
    expect(rows.rows[0]).toMatchObject({
      output_state_hash: null,
      transition_id: null,
      hunk_id: null,
    });
  });

  it("traces snippet blame through file-version ancestry", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-blame" });
    const initial = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{
        kind: "file_observed",
        actor: "initial",
        payload: {
          path: "src/index.ts",
          contentHash: "blob:v1",
          operation: "write",
          mode: 0o100644,
          afterText: "alpha\nbeta\ngamma",
          newString: "alpha\nbeta\ngamma",
        },
      }],
    });
    const edited = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: initial.headTrajectoryHash,
      expectedStateHash: initial.headStateHash,
      items: [{
        kind: "file_mutation",
        actor: "editor",
        toolCallId: "tool-edit",
        payload: {
          path: "src/index.ts",
          contentHash: "blob:v2",
          operation: "write",
          mode: 0o100644,
          beforeText: "alpha\nbeta\ngamma",
          afterText: "alpha\nbeta\nGAMMA",
          oldString: "gamma",
          newString: "GAMMA",
        },
      }],
    });

    const unchangedLine = await call<Array<Record<string, unknown>>>("blameGadFileSnippet", {
      stateHash: edited.headStateHash,
      path: "src/index.ts",
      startLine: 1,
      endLine: 1,
    });
    expect(unchangedLine[0]).toMatchObject({
      actor: "initial",
      kind: "file_observed",
    });

    const changedLine = await call<Array<Record<string, unknown>>>("blameGadFileSnippet", {
      stateHash: edited.headStateHash,
      path: "src/index.ts",
      startLine: 3,
      endLine: 3,
    });
    expect(changedLine[0]).toMatchObject({
      actor: "editor",
      kind: "file_mutation",
      origin_tool_call_id: "tool-edit",
    });
  });

  it("traces snippet blame across line shifts and unrelated later edits", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-shift-blame" });
    const initialText = "one\ntwo\nthree\nfour";
    const insertedText = "intro\none\ntwo\nthree\nfour";
    const targetEditedText = "intro\none\ntwo\nTHREE\nfour";
    const laterEditedText = "intro\nONE\ntwo\nTHREE\nfour";
    const initial = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [{
        kind: "file_observed",
        actor: "initial",
        payload: {
          path: "shift.txt",
          contentHash: "blob:shift:1",
          operation: "write",
          mode: 0o100644,
          afterText: initialText,
          newString: initialText,
        },
      }],
    });
    const inserted = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: initial.headTrajectoryHash,
      expectedStateHash: initial.headStateHash,
      items: [{
        kind: "file_mutation",
        actor: "insert",
        payload: {
          path: "shift.txt",
          contentHash: "blob:shift:2",
          operation: "write",
          mode: 0o100644,
          beforeText: initialText,
          afterText: insertedText,
          oldString: "",
          newString: "intro\n",
        },
      }],
    });
    const targetEdited = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: inserted.headTrajectoryHash,
      expectedStateHash: inserted.headStateHash,
      items: [{
        kind: "file_mutation",
        actor: "target",
        payload: {
          path: "shift.txt",
          contentHash: "blob:shift:3",
          operation: "write",
          mode: 0o100644,
          beforeText: insertedText,
          afterText: targetEditedText,
          oldString: "three",
          newString: "THREE",
        },
      }],
    });
    const laterEdited = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: targetEdited.headTrajectoryHash,
      expectedStateHash: targetEdited.headStateHash,
      items: [{
        kind: "file_mutation",
        actor: "later",
        payload: {
          path: "shift.txt",
          contentHash: "blob:shift:4",
          operation: "write",
          mode: 0o100644,
          beforeText: targetEditedText,
          afterText: laterEditedText,
          oldString: "one",
          newString: "ONE",
        },
      }],
    });

    const targetLine = await call<Array<Record<string, unknown>>>("blameGadFileSnippet", {
      stateHash: laterEdited.headStateHash,
      path: "shift.txt",
      startLine: 4,
      endLine: 4,
    });
    expect(targetLine[0]).toMatchObject({ actor: "target", kind: "file_mutation" });

    const shiftedUnchangedLine = await call<Array<Record<string, unknown>>>("blameGadFileSnippet", {
      stateHash: laterEdited.headStateHash,
      path: "shift.txt",
      startLine: 5,
      endLine: 5,
    });
    expect(shiftedUnchangedLine[0]).toMatchObject({ actor: "initial", kind: "file_observed" });
  });

  it("reports structured integrity errors for corrupted graph rows", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensureGadBranch", { branchId: "branch-corrupt" });
    const append = await call<any>("appendGadTrajectoryBatch", {
      branchId: head.branchId,
      expectedTrajectoryHash: head.headTrajectoryHash,
      expectedStateHash: head.headStateHash,
      items: [
        { kind: "system_event", actor: "test", payload: { parent: true } },
        {
          kind: "file_observed",
          actor: "test",
          payload: { path: "corrupt.txt", contentHash: "blob:corrupt", operation: "write", mode: 0o100644 },
        },
      ],
    });

    await call("rawSql", "UPDATE gad_trajectory_items SET parent_hash = 'trajectory:wrong' WHERE id = ?", [append.items[1].id]);
    await call("rawSql", "UPDATE gad_branches SET head_trajectory_hash = 'trajectory:wrong-head' WHERE id = ?", ["branch-corrupt"]);
    await call("rawSql", "UPDATE gad_state_transitions SET output_state_hash = 'state:missing' WHERE trajectory_id = ?", [append.items[1].id]);
    await call("rawSql", "UPDATE gad_file_change_hunks SET after_file_version_id = 99999 WHERE trajectory_id = ?", [append.items[1].id]);

    const integrity = await call<{ ok: boolean; errors: Array<{ code: string }> }>("checkGadIntegrity", {
      branchId: "branch-corrupt",
    });
    expect(integrity.ok).toBe(false);
    expect(integrity.errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "parent_hash_mismatch" }),
      expect.objectContaining({ code: "branch_head_hash_mismatch" }),
      expect.objectContaining({ code: "state_transition_missing_output_state" }),
      expect.objectContaining({ code: "file_hunk_missing_file_version" }),
    ]));
  });
});
