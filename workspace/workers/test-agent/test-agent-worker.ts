import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ParticipantDescriptor } from "@natstack/harness/types";

/**
 * TestAgentWorker — Minimal agent DO for testing the Pi runtime pipeline.
 *
 * Uses the default `workspace/AGENTS.md` system prompt resolved by the
 * base class via the workspace.* RPC service. Tests that need a
 * different prompt drop a per-test `AGENTS.md` file at the workspace
 * root before spawning the worker.
 */
export class TestAgentWorker extends AgentWorkerBase {
  static override schemaVersion = 5;

  /** Anthropic sonnet — smaller surface for unit tests than OpenAI Codex. */
  protected override getModel(): string {
    return "anthropic:claude-sonnet-4-20250514";
  }

  protected override getParticipantInfo(): ParticipantDescriptor {
    return {
      handle: "test-agent",
      name: "Test Agent",
      type: "agent",
      metadata: {},
      methods: [],
    };
  }
}
