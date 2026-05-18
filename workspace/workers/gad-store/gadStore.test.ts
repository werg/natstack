import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { GadWorkspaceDO } from "./index.js";

let counter = 0;
function id(prefix: string): string {
  counter += 1;
  return `${prefix}-${counter}`;
}

describe("GadWorkspaceDO clean Pi/GAD persistence", () => {
  it("stores Pi entries, blocks, and tool-call projections without legacy tables", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const head = await call<any>("ensurePiBranch", { branchId: "main", channelId: "ch-1" });
    expect(head.headEntryId).toBeNull();

    const user = id("user");
    const assistant = id("assistant");
    const result = await call<any>("appendPiEntryBatch", {
      branchId: "main",
      expectedHeadEntryHash: head.headEntryHash,
      expectedStateHash: head.headStateHash,
      items: [
        {
          entryId: user,
          parentEntryId: null,
          entryType: "message",
          payload: { message: { role: "user", content: "read it", timestamp: 1 } },
        },
        {
          entryId: assistant,
          parentEntryId: user,
          entryType: "message",
          payload: {
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "ok" },
                { type: "toolCall", id: "tc-1", name: "read", input: { path: "README.md" } },
              ],
              timestamp: 2,
            },
          },
        },
      ],
    });

    expect(result.headEntryId).toBe(assistant);
    expect(result.headEntryHash).toMatch(/^pi-entry-v1:/);

    const context = await call<{ messages: Array<Record<string, unknown>> }>("materializePiMessages", {
      branchId: "main",
    });
    expect(context.messages.map((msg) => msg["role"])).toEqual(["user", "assistant"]);

    const blocks = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT block_type, text, tool_call_id, tool_name FROM pi_message_blocks ORDER BY message_entry_id, block_index",
      [],
    );
    expect(blocks.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ block_type: "text", text: "read it" }),
      expect.objectContaining({ block_type: "toolCall", tool_call_id: "tc-1", tool_name: "read" }),
    ]));

    const tables = await call<{ rows: Array<{ name: string }> }>(
      "query",
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      [],
    );
    expect(tables.rows.map((row) => row.name)).not.toEqual(expect.arrayContaining([
      "gad_trajectory_items",
      "gad_branches",
      "gad_state_roots",
      "gad_payloads",
    ]));
  });

  it("keeps GAD sidecars out of Pi context and records a Merkle event chain", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("ensurePiBranch", { branchId: "main" });
    await call("appendPiEntryBatch", {
      branchId: "main",
      items: [{
        entryId: id("msg"),
        parentEntryId: null,
        entryType: "message",
        payload: { message: { role: "user", content: "hello", timestamp: 1 } },
      }],
    });

    await call("appendGadEvents", {
      events: [
        {
          eventId: id("event"),
          kind: "system_event",
          anchorKind: "system",
          anchorId: "test",
          payload: { kind: "audit", note: "not model visible" },
        },
        {
          eventId: id("event"),
          kind: "claim_recorded",
          anchorKind: "entry",
          anchorId: "msg",
          payload: { text: "hello was said", confidence: 0.9 },
        },
      ],
    });

    const context = await call<{ messages: Array<Record<string, unknown>> }>("materializePiMessages", {
      branchId: "main",
    });
    expect(context.messages).toHaveLength(1);

    const events = await call<Array<Record<string, unknown>>>("listGadEvents", {});
    expect(events).toHaveLength(2);
    expect(events[0]?.["event_hash"]).toMatch(/^gad-event-v1:/);
    expect(events[1]?.["prev_event_hash"]).toBe(events[0]?.["event_hash"]);

    const claims = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT text, status FROM gad_claims",
      [],
    );
    expect(claims.rows).toEqual([expect.objectContaining({ text: "hello was said", status: "active" })]);
  });

  it("records file mutations as events, states, transitions, diff, read, and blame data", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("appendGadEvents", {
      events: [
        {
          eventId: "plan-1",
          kind: "file_mutation_planned",
          anchorKind: "tool_call",
          anchorId: "tc-write",
          payload: {
            mutationId: "mut-1",
            toolCallId: "tc-write",
            path: "src/index.ts",
            operation: "write",
            plannedTool: "write",
            plannedParams: { path: "src/index.ts" },
          },
        },
        {
          eventId: "obs-1",
          kind: "file_mutation_observed",
          anchorKind: "tool_call",
          anchorId: "tc-write",
          payload: {
            mutationId: "mut-1",
            toolCallId: "tc-write",
            path: "src/index.ts",
            operation: "write",
            inputStateHash: "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7",
            afterHash: "blob:v1",
            outcome: "ok",
            hunks: [
              {
                oldStartLine: 4,
                oldLineCount: 2,
                newStartLine: 4,
                newLineCount: 3,
                oldTextHash: "blob:old-lines",
                newTextHash: "blob:new-lines",
              },
            ],
          },
        },
      ],
    });

    const mutation = await call<{ rows: Array<Record<string, unknown>> }>(
      "query",
      "SELECT output_state_hash FROM gad_file_mutations WHERE mutation_id = ?",
      ["mut-1"],
    );
    const outputStateHash = String(mutation.rows[0]?.["output_state_hash"]);
    expect(outputStateHash).toMatch(/^state:[0-9a-f]{64}$/);

    const producer = await call<Record<string, unknown>>("getGadStateProducer", {
      stateHash: outputStateHash,
    });
    expect(producer).toMatchObject({ event_id: "obs-1", produced_by_tool_call_id: "tc-write" });

    const file = await call<Record<string, unknown> | null>("readGadFileAtState", {
      stateHash: outputStateHash,
      path: "src/index.ts",
    });
    expect(file).toMatchObject({ path: "src/index.ts", content_hash: "blob:v1" });

    const diff = await call<{ added: Array<Record<string, unknown>>; removed: unknown[]; changed: unknown[] }>(
      "diffGadStates",
      {
        leftStateHash: "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7",
        rightStateHash: outputStateHash,
      },
    );
    expect(diff.added).toEqual([expect.objectContaining({ path: "src/index.ts" })]);

    const blame = await call<Array<Record<string, unknown>>>("blameGadFileSnippet", {
      stateHash: outputStateHash,
      path: "src/index.ts",
    });
    expect(blame[0]).toMatchObject({
      mutation_id: "mut-1",
      tool_call_id: "tc-write",
      old_start_line: 4,
      old_line_count: 2,
      new_start_line: 4,
      new_line_count: 3,
      old_text_hash: "blob:old-lines",
      new_text_hash: "blob:new-lines",
    });

    await call("ensurePiBranch", { branchId: "main" });
    const appended = await call<any>("appendPiEntryBatch", {
      branchId: "main",
      expectedStateHash: "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7",
      items: [{
        entryId: "after-mutation",
        parentEntryId: null,
        entryType: "message",
        preStateHash: "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7",
        postStateHash: outputStateHash,
        payload: { message: { role: "assistant", content: "changed", timestamp: 3 } },
      }],
    });
    expect(appended.headStateHash).toBe(outputStateHash);

    const integrity = await call<{ ok: boolean; errors: Array<Record<string, unknown>> }>("checkGadIntegrity", {});
    expect(integrity).toEqual({ ok: true, errors: [] });

    const replay = await call<{ replayed: number }>("replayGadEvents", {});
    expect(replay.replayed).toBe(2);
    const replayIntegrity = await call<{ ok: boolean; errors: Array<Record<string, unknown>> }>("checkGadIntegrity", {});
    expect(replayIntegrity).toEqual({ ok: true, errors: [] });
  });

  it("reports direct corruption across Pi entries, event chains, manifests, and transitions", async () => {
    const { call, sql } = await createTestDO(GadWorkspaceDO);
    await call("ensurePiBranch", { branchId: "main" });
    await call("appendPiEntryBatch", {
      branchId: "main",
      items: [{
        entryId: "msg-1",
        parentEntryId: null,
        entryType: "message",
        payload: { message: { role: "user", content: "hello", timestamp: 1 } },
      }],
    });
    await call("appendGadEvents", {
      events: [{
        eventId: "obs-corrupt",
        kind: "file_mutation_observed",
        payload: {
          mutationId: "mut-corrupt",
          path: "a/b.txt",
          operation: "write",
          inputStateHash: "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7",
          afterHash: "blob:content",
          outcome: "ok",
        },
      }],
    });

    sql.exec(
      "UPDATE pi_session_entries SET raw_entry_json = ? WHERE entry_id = ?",
      JSON.stringify({ entryId: "msg-1", parentEntryId: null, entryType: "message", actor: null, payload: { message: { role: "user", content: "tampered", timestamp: 1 } }, metadata: null }),
      "msg-1",
    );
    sql.exec("UPDATE gad_events SET prev_event_hash = ? WHERE event_id = ?", "gad-event-v1:bad", "obs-corrupt");
    sql.exec("UPDATE gad_manifest_entries SET name = ? WHERE name = ?", "renamed.txt", "b.txt");
    sql.exec("UPDATE gad_state_transitions SET output_state_hash = ? WHERE event_id = ?", "state:missing", "obs-corrupt");

    const integrity = await call<{ ok: boolean; errors: Array<Record<string, unknown>> }>("checkGadIntegrity", {});
    expect(integrity.ok).toBe(false);
    expect(integrity.errors.map((error) => error["type"])).toEqual(expect.arrayContaining([
      "pi-entry",
      "gad-event",
      "manifest",
      "state-transition",
    ]));
  });

  it("enforces dispatch and approval lifecycles", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await expect(call("appendGadEvents", {
      events: [{
        eventId: "dispatch-resolve-missing",
        kind: "dispatch_resolved",
        payload: { dispatchCallId: "missing", resultEntryId: "entry" },
      }],
    })).rejects.toThrow(/unknown dispatch/u);

    await call("appendGadEvents", {
      events: [
        {
          eventId: "dispatch-pending",
          kind: "dispatch_pending",
          payload: { dispatchCallId: "dispatch-1", toolCallId: "tc-1", methodName: "tool.run" },
        },
        {
          eventId: "dispatch-resolved",
          kind: "dispatch_resolved",
          payload: { dispatchCallId: "dispatch-1", resultEntryId: "entry-1" },
        },
      ],
    });
    await expect(call("appendGadEvents", {
      events: [{
        eventId: "dispatch-resolved-again",
        kind: "dispatch_resolved",
        payload: { dispatchCallId: "dispatch-1", resultEntryId: "entry-2" },
      }],
    })).rejects.toThrow(/from status resolved/u);

    await expect(call("appendGadEvents", {
      events: [{
        eventId: "approval-resolve-missing",
        kind: "approval_resolved",
        payload: { approvalId: "missing", decision: "allow" },
      }],
    })).rejects.toThrow(/unknown approval/u);

    await call("appendGadEvents", {
      events: [
        {
          eventId: "approval-requested",
          kind: "approval_requested",
          payload: { approvalId: "approval-1", toolCallId: "tc-1", requestedByEntryId: "entry-1" },
        },
        {
          eventId: "approval-resolved",
          kind: "approval_resolved",
          payload: { approvalId: "approval-1", decision: "allow", resolvedBy: "user" },
        },
      ],
    });
    await expect(call("appendGadEvents", {
      events: [{
        eventId: "approval-resolved-again",
        kind: "approval_resolved",
        payload: { approvalId: "approval-1", decision: "deny", resolvedBy: "user" },
      }],
    })).rejects.toThrow(/more than once/u);
  });

  it("tracks index jobs through claim, retry, failure, requeue, and completion", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    const created = await call<{ id: number }>("enqueueGadIndexJob", {
      sourceHash: "claim:1",
      sourceKind: "claim",
      jobKind: "embed",
    });

    const claimed = await call<Array<Record<string, unknown>>>("claimGadIndexJobs", { limit: 1 });
    expect(claimed).toHaveLength(1);
    expect(claimed[0]).toMatchObject({ id: created.id, status: "running", attempts: 1 });

    const retry = await call<Record<string, unknown>>("failGadIndexJob", {
      id: created.id,
      error: "rate limited",
      retry: true,
    });
    expect(retry).toMatchObject({ status: "retry", error: "rate limited" });

    const retried = await call<Array<Record<string, unknown>>>("claimGadIndexJobs", { limit: 1 });
    expect(retried[0]).toMatchObject({ id: created.id, status: "running", attempts: 2 });

    const failed = await call<Record<string, unknown>>("failGadIndexJob", {
      id: created.id,
      error: "bad source",
    });
    expect(failed).toMatchObject({ status: "failed", error: "bad source" });

    await call("enqueueGadIndexJob", {
      sourceHash: "claim:1",
      sourceKind: "claim",
      jobKind: "embed",
    });
    const requeued = await call<Array<Record<string, unknown>>>("listGadIndexJobs", { status: "queued" });
    expect(requeued).toEqual([expect.objectContaining({ id: created.id, error: null })]);

    const reclaimed = await call<Array<Record<string, unknown>>>("claimGadIndexJobs", { limit: 1 });
    const complete = await call<Record<string, unknown>>("completeGadIndexJob", { id: Number(reclaimed[0]?.["id"]) });
    expect(complete).toMatchObject({ id: created.id, status: "complete", error: null });
  });

  it("forks Pi branches by entry or raw worktree state", async () => {
    const { call } = await createTestDO(GadWorkspaceDO);
    await call("ensurePiBranch", { branchId: "main" });
    const first = id("entry");
    await call("appendPiEntryBatch", {
      branchId: "main",
      items: [{
        entryId: first,
        parentEntryId: null,
        entryType: "message",
        payload: { message: { role: "user", content: "base", timestamp: 1 } },
      }],
    });

    const conversationFork = await call<any>("forkPiBranch", {
      sourceBranchId: "main",
      newBranchId: "fork-entry",
      entryId: first,
    });
    expect(conversationFork.headEntryId).toBe(first);

    const worldFork = await call<any>("forkPiBranch", {
      sourceBranchId: "main",
      newBranchId: "fork-state",
      stateHash: "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7",
    });
    expect(worldFork.headEntryId).toBeNull();
    expect(worldFork.headStateHash).toBe("state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7");
  });
});
