import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ParticipantDescriptor } from "@natstack/harness/types";

/**
 * TestAgentWorker — Minimal agent DO for testing the Pi runtime pipeline.
 *
 * The system prompt lives in the test contextFolder's `.pi/AGENTS.md`
 * (typically a copy of the workspace prompt with test-specific overrides).
 * Tests that need a different prompt write a per-test AGENTS.md file before
 * spawning the worker.
 */
export class TestAgentWorker extends AgentWorkerBase {
  static override schemaVersion = 4;

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
