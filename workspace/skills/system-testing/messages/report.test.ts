import { describe, expect, it, vi } from "vitest";
import { reportStage } from "./report.js";
import type { StageReportState } from "./report-types.js";
import type { ChatMessage } from "@workspace/agentic-core";
import type { TestSuiteResultEntry } from "../types.js";

function entry(
  name: string,
  category: string,
  passed: boolean,
  opts: {
    reason?: string;
    error?: string;
    duration?: number;
    messages?: ChatMessage[];
    snapshot?: TestSuiteResultEntry["execution"]["snapshot"];
    toolFailures?: TestSuiteResultEntry["execution"]["toolFailures"];
  } = {},
): TestSuiteResultEntry {
  return {
    test: { name, category, description: `desc ${name}`, prompt: `do ${name}` },
    result: { passed, reason: opts.reason },
    execution: {
      messages: opts.messages ?? [],
      duration: opts.duration ?? 100,
      error: opts.error,
      snapshot: opts.snapshot,
      toolFailures: opts.toolFailures,
    },
  };
}

function makeScope(entries: TestSuiteResultEntry[], stage: { index: number; name: string; category: string }) {
  const aggregate = {
    total: entries.length,
    passed: entries.filter((e) => e.result.passed).length,
    failed: entries.filter((e) => !e.result.passed && !e.execution.error).length,
    errored: entries.filter((e) => Boolean(e.execution.error)).length,
    toolFailureCount: entries.reduce((count, e) => count + (e.execution.toolFailures?.length ?? 0), 0),
    testsWithToolFailures: entries.filter((e) => (e.execution.toolFailures?.length ?? 0) > 0).length,
    skipped: 0,
    duration: entries.reduce((s, e) => s + (e.execution.duration ?? 0), 0),
    results: entries,
  };
  return {
    systemTestingRun: {
      runId: "run-1",
      // The init eval stores tests as a compact array of name strings.
      stages: [{ ...stage, tests: entries.map((e) => e.test.name) }],
      lastStageSummary: { index: stage.index, name: stage.name, category: stage.category },
      results: aggregate,
    },
  } as Record<string, unknown>;
}

function makeChat() {
  const published: Array<{ typeId: string; initialState: StageReportState }> = [];
  const registered: string[] = [];
  const chat = {
    registerMessageType: vi.fn(async (input: { typeId: string }) => {
      registered.push(input.typeId);
      return 1;
    }),
    publishCustomMessage: vi.fn(async (input: { typeId: string; initialState: unknown }) => {
      published.push({ typeId: input.typeId, initialState: input.initialState as StageReportState });
      return { messageId: `msg-${published.length}`, pubsubId: published.length };
    }),
  };
  return { chat: chat as unknown as Parameters<typeof reportStage>[0], published, registered };
}

describe("reportStage", () => {
  it("publishes a bounded stage report card for the last completed stage", async () => {
    const entries = [
      entry("fs-write", "filesystem", true),
      entry("fs-read", "filesystem", true),
      entry("fs-symlink", "filesystem", false, { reason: "symlink target missing" }),
    ];
    const scope = makeScope(entries, { index: 0, name: "filesystem", category: "filesystem" });
    const { chat, published, registered } = makeChat();

    const { messageId } = await reportStage(chat, scope, { prose: "two passed, one symlink failed" });

    expect(messageId).toBe("msg-1");
    expect(registered).toEqual(["system-testing.stage-report"]);
    expect(published).toHaveLength(1);

    const state = published[0]!.initialState;
    expect(state.runId).toBe("run-1");
    expect(state.category).toBe("filesystem");
    expect(state.title).toBe("filesystem");
    expect(state.prose).toBe("two passed, one symlink failed");
    expect(state.counts).toMatchObject({ total: 3, passed: 2, failed: 1, errored: 0 });
    expect(state.tests.map((t) => t.status)).toEqual(["passed", "passed", "failed"]);
    // Every test carries a bounded diagnostic for drill-down (pass and fail).
    expect(state.tests.every((t) => Boolean(t.detail))).toBe(true);
    expect(state.tests[0]!.detail.passed).toBe(true);
    const symlink = state.tests.find((t) => t.name === "fs-symlink")!;
    expect(symlink.detail.passed).toBe(false);
    expect(symlink.detail.validationReason).toBe("symlink target missing");
  });

  it("reports tool failures separately from task failures", async () => {
    const entries = [
      entry("recovered-tool-error", "smoke", true, {
        toolFailures: [
          {
            id: "call-1",
            name: "eval",
            status: "error",
            terminalOutcome: "tool_error",
            error: "ReferenceError: missingVar is not defined",
            source: "message",
          },
        ],
      }),
    ];
    const scope = makeScope(entries, { index: 0, name: "smoke", category: "smoke" });
    const { chat, published } = makeChat();

    await reportStage(chat, scope, { prose: "one task passed with one tool failure" });

    const state = published[0]!.initialState;
    expect(state.counts).toMatchObject({
      passed: 1,
      failed: 0,
      errored: 0,
      toolFailureCount: 1,
      testsWithToolFailures: 1,
    });
    expect(state.tests[0]).toMatchObject({
      status: "passed",
      toolFailureCount: 1,
      toolFailures: [expect.objectContaining({ name: "eval" })],
    });
  });

  it("does not trim raw execution evidence after publishing a report", async () => {
    const messages = [
      {
        id: "prompt-1",
        senderId: "headless",
        kind: "message",
        complete: true,
        content: "prompt",
      },
    ] satisfies ChatMessage[];
    const snapshot = {
      messages,
      invocations: [{ id: "call-1", name: "read", status: "complete" }],
      debugEvents: [],
      cleanupErrors: [],
      participants: {},
      localMethodNames: [],
      connected: true,
      duration: 10,
      title: null,
    };
    const entries = [
      entry("passing-with-evidence", "smoke", true, {
        messages,
        snapshot,
      }),
    ];
    const scope = makeScope(entries, { index: 0, name: "smoke", category: "smoke" });
    const { chat } = makeChat();

    await reportStage(chat, scope, { prose: "passed" });

    expect(entries[0]!.execution.messages).toBe(messages);
    expect(entries[0]!.execution.snapshot).toBe(snapshot);
  });

  it("registers the renderer only once per run", async () => {
    const entries = [entry("a", "smoke", true)];
    const scope = makeScope(entries, { index: 0, name: "smoke", category: "smoke" });
    const { chat, registered } = makeChat();

    await reportStage(chat, scope, { prose: "ok" });
    await reportStage(chat, scope, { prose: "ok again" });

    expect(registered).toEqual(["system-testing.stage-report"]);
  });

  it("bounds the card to the stage's own tests when a category spans stages", async () => {
    const entries = [
      entry("fs-1", "filesystem", true),
      entry("fs-2", "filesystem", false, { reason: "boom" }),
      entry("fs-3", "filesystem", true),
    ];
    const scope = makeScope(entries, { index: 1, name: "filesystem 2/2", category: "filesystem" });
    // Stage 1/2 only owns fs-1; stage 2/2 owns fs-2, fs-3.
    (scope["systemTestingRun"] as { stages: Array<{ index: number; name: string; category: string; tests: Array<{ name: string }> }> }).stages = [
      { index: 0, name: "filesystem 1/2", category: "filesystem", tests: [{ name: "fs-1" }] },
      { index: 1, name: "filesystem 2/2", category: "filesystem", tests: [{ name: "fs-2" }, { name: "fs-3" }] },
    ];
    const { chat, published } = makeChat();

    await reportStage(chat, scope, { prose: "second chunk" });

    const state = published[0]!.initialState;
    expect(state.title).toBe("filesystem 2/2");
    expect(state.tests.map((t) => t.name)).toEqual(["fs-2", "fs-3"]);
    expect(state.counts.total).toBe(2);
  });

  it("throws when there is no active run", async () => {
    const { chat } = makeChat();
    await expect(reportStage(chat, {}, { prose: "x" })).rejects.toThrow(/systemTestingRun/);
  });
});
