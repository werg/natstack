/**
 * E2E: deferred credential park → hibernate → approve → auto-resume.
 *
 * Wires a REAL agent Durable Object (in-memory SQLite) to the REAL server-side
 * `DeferralRegistry`, with a controllable human approval, and exercises the full
 * round-trip the unit tests can only mock in halves:
 *
 *   1. The agent's model-acquisition defers a credential-use approval and PARKS
 *      the turn (durable suspension row; no in-process hold).
 *   2. The DO HIBERNATES — a fresh DO instance, empty in-memory state, backed by
 *      the SAME durable storage (second `createTestDO` sharing the db).
 *   3. The human approves (long after hibernation). The registry settles the
 *      detached work and delivers `onDeferredResult` to the REVIVED DO, which
 *      auto-resumes the SAME turn (the north-star UX).
 *   4. A duplicate delivery is a no-op (idempotent atomic claim).
 *
 * (The post-hibernation steer-into-open-turn collision fix, P0-2, is covered at
 * the dispatcher unit level — it turns on `runner.getCurrentTurnId()`, which a
 * mock runner here cannot exercise faithfully.)
 */

import { describe, it, expect, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { AgentWorkerBase } from "@workspace/agentic-do";
import type { PiRunner } from "@workspace/harness";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  deferIfNeeded,
  isDeferredResult,
  createVerifiedCaller,
  type ServiceContext,
} from "@natstack/shared/serviceDispatcher";
import { DeferralRegistry } from "../../src/server/services/deferralRegistry.js";

const CALLER_ID = "do:workers/agent:E2ECredentialWorker:agent-1";
const MODEL_URL = "https://model.example/v1";

class E2ECredentialWorker extends AgentWorkerBase {
  protected override getDefaultModel(): string {
    return "test:model";
  }
  protected override async refreshRoster(): Promise<void> {}
  protected override async getOrCreateRunner(channelId: string): Promise<PiRunner> {
    const runners = (this as unknown as { runners: Map<string, { runner: PiRunner }> }).runners;
    return runners.get(channelId)!.runner;
  }
}

type WorkerInternals = {
  _rpc: Record<string, unknown>;
  _currentVerifiedCaller: { callerId: string; callerKind: string } | null;
  subscriptions: { getParticipantId(channelId: string): string | null };
  runners: Map<string, unknown>;
  dispatchers: Map<string, unknown>;
  createChannelClient: ReturnType<typeof vi.fn>;
  getOrCreateDispatcher: ReturnType<typeof vi.fn>;
  getModelBaseUrl(channelId: string): string;
  getApiKeyForChannel(channelId: string): () => Promise<string>;
  readRunnerMessages(channelId: string): Promise<AgentMessage[]>;
  onDeferredResult(payload: {
    requestId: string;
    result: unknown;
    isError: boolean;
  }): Promise<{ ok: boolean }>;
};

const userMessage = { role: "user", content: "onboard me", timestamp: 1 } as AgentMessage;
// What pi-agent-core records when getApiKey throws the (suppressed) park signal.
const parkErrorMessage = {
  role: "assistant",
  content: [],
  timestamp: 2,
  api: "openai",
  provider: "test",
  model: "model",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {} },
  stopReason: "error",
  errorMessage: "Waiting for model credential approval for provider: test",
} as unknown as AgentMessage;

describe("E2E: credential park → hibernate → approve → auto-resume", () => {
  it("round-trips a deferred credential approval through a real DeferralRegistry and a hibernation", async () => {
    // The human approval the server is waiting on (resolved late, post-hibernation).
    let approve!: () => void;
    const approval = new Promise<void>((resolve) => {
      approve = resolve;
    });

    // The live DO the registry should deliver to (re-pointed on hibernation).
    let liveDO: E2ECredentialWorker;
    const registry = new DeferralRegistry({
      deliver: async (callerId, requestId, result, isError) => {
        (liveDO as unknown as WorkerInternals)._currentVerifiedCaller = {
          callerId: "server",
          callerKind: "server",
        };
        await (liveDO as unknown as WorkerInternals).onDeferredResult({ requestId, result, isError });
      },
      logger: console,
    });

    // A real deferred `credentials.resolveCredential`: defers behind the human
    // approval, exactly like the server service does via `ctx.deferral`.
    const resolveCredentialDeferred = async (
      requestId: string
    ): Promise<{ status: "deferred"; requestId: string } | { status: "completed"; result: unknown }> => {
      const ctx: ServiceContext = {
        caller: createVerifiedCaller(CALLER_ID, "do", {
          callerId: CALLER_ID,
          callerKind: "do",
          repoPath: "workers/agent",
          effectiveVersion: "v1",
        }),
        requestId,
        deferral: registry.createApi({
          callerId: CALLER_ID,
          requestId,
          service: "credentials",
          method: "resolveCredential",
        }),
      } as ServiceContext;
      const produce = async () => {
        await approval; // the human decision
        return { id: "cred-1" };
      };
      const outcome = deferIfNeeded(ctx, true, produce);
      if (isDeferredResult(outcome)) return { status: "deferred", requestId };
      return { status: "completed", result: await outcome };
    };

    // ── Mock runner + dispatcher (shared shape across both DO instances) ──────
    const moveTo = vi.fn().mockResolvedValue(undefined);
    function configure(worker: E2ECredentialWorker, transcript: () => AgentMessage[]) {
      const submitContinue = vi.fn();
      const dispatcher = { submitContinue, getDebugState: () => ({ busy: false }) };
      const runner = {
        getCurrentTurnId: () => "turn-e2e",
        session: {
          getEntries: vi.fn(async () => [
            { id: "entry-user", type: "message" },
            { id: "entry-assistant-error", type: "message" },
          ]),
          moveTo,
        },
      };
      const w = worker as unknown as WorkerInternals;
      w._rpc = {
        call: vi.fn(),
        callDeferred: vi.fn(
          async (_t: string, _m: string, _a: unknown[], opts?: { requestId?: string }) =>
            resolveCredentialDeferred(opts!.requestId!)
        ),
        stream: vi.fn(),
        emit: vi.fn(),
        on: vi.fn(),
        handleIncomingPost: vi.fn(),
      };
      w.subscriptions.getParticipantId = vi.fn().mockReturnValue("do:agent");
      w.createChannelClient = vi.fn().mockReturnValue({
        getParticipants: vi.fn().mockResolvedValue([]),
        publishAgenticEvent: vi.fn(async () => undefined),
      });
      w.getModelBaseUrl = vi.fn().mockReturnValue(MODEL_URL);
      w.readRunnerMessages = vi.fn(async () => transcript());
      w.runners.set("chat-1", { runner });
      w.dispatchers.set("chat-1", dispatcher);
      w.getOrCreateDispatcher = vi.fn().mockReturnValue(dispatcher);
      return { submitContinue };
    }

    // ── 1) First DO instance parks on the deferred approval ───────────────────
    const first = await createTestDO(E2ECredentialWorker, { __objectKey: "agent-1" });
    liveDO = first.instance;
    let transcript: AgentMessage[] = [userMessage];
    configure(first.instance, () => transcript);

    await expect(
      (first.instance as unknown as WorkerInternals).getApiKeyForChannel("chat-1")()
    ).rejects.toThrow(/Waiting for model credential approval/);

    // Durable suspension persisted (the round-trip key), turn parked waiting.
    const parkedRow = first.sql
      .exec(`SELECT request_id, status FROM suspensions WHERE channel_id = ?`, "chat-1")
      .toArray()[0];
    expect(parkedRow?.["status"]).toBe("suspended");
    const requestId = parkedRow?.["request_id"] as string;
    expect(requestId).toBeTruthy();
    expect(
      first.sql.exec(`SELECT status FROM agent_turn_runs WHERE turn_id = ?`, "turn-e2e").toArray()[0]?.[
        "status"
      ]
    ).toBe("waiting_external");

    // ── 2) HIBERNATE: a fresh DO instance over the SAME durable storage ───────
    const second = await createTestDO(E2ECredentialWorker, { __objectKey: "agent-1" }, { db: first.db });
    liveDO = second.instance;
    // pi-agent-core has appended the (channel-suppressed) park error message.
    transcript = [userMessage, parkErrorMessage];
    const { submitContinue } = configure(second.instance, () => transcript);

    // The suspension survived hibernation (the durable round-trip key).
    expect(
      second.sql.exec(`SELECT status FROM suspensions WHERE request_id = ?`, requestId).toArray()[0]?.[
        "status"
      ]
    ).toBe("suspended");

    // ── 3) Approve (post-hibernation) → registry delivers to the revived DO ───
    expect(submitContinue).not.toHaveBeenCalled();
    approve();
    await vi.waitFor(() => expect(submitContinue).toHaveBeenCalledWith({ turnId: "turn-e2e" }));

    // The revived DO auto-resumed the SAME turn: rewound past the park message,
    // cleared the suspension, turn back to continuing.
    expect(moveTo).toHaveBeenCalledWith("entry-user");
    expect(second.sql.exec(`SELECT * FROM suspensions WHERE request_id = ?`, requestId).toArray()).toHaveLength(0);
    expect(
      second.sql.exec(`SELECT status FROM agent_turn_runs WHERE turn_id = ?`, "turn-e2e").toArray()[0]?.[
        "status"
      ]
    ).toBe("continuing");

    // ── 4) A duplicate delivery is a no-op (idempotent atomic claim) ──────────
    submitContinue.mockClear();
    (second.instance as unknown as WorkerInternals)._currentVerifiedCaller = {
      callerId: "server",
      callerKind: "server",
    };
    await (second.instance as unknown as WorkerInternals)
      .onDeferredResult({ requestId, result: { id: "cred-1" }, isError: false })
      .catch(() => undefined);
    expect(submitContinue).not.toHaveBeenCalled();
  });
});
