/**
 * Chat transcript suite — in-system port of tests/e2e/flows/chatTranscript.spec.ts.
 *
 * Opens panels/chat wired to the deterministic test agent
 * (workers/test-agent), then asserts the transcript renders the initial
 * prompt, an eval tool bead that transitions pending → complete, and the
 * deterministic agent reply — without raw tool-call/JSON leakage.
 */
import { suite } from "../run.js";
import { expect } from "../expect.js";
import { evalInPanel, panelText, waitFor, waitForText, withPanel } from "../panels.js";

const INITIAL_PROMPT = "Testkit initial prompt for the chat transcript suite";
const AGENT_REPLY = "Deterministic agent reply from the test worker.";

const CHAT_STATE_ARGS = {
  initialPrompt: INITIAL_PROMPT,
  agentSource: "workers/test-agent",
  agentClass: "TestAgentWorker",
  agentConfig: {
    deterministicResponse: true,
    responseText: AGENT_REPLY,
    code: "read('skills/onboarding/SKILL.md')",
    delayMs: 500,
  },
};

export const chatTranscript = suite("chat-transcript", { timeoutMs: 120_000 }).test(
  "renders prompt, eval bead pending→complete, and agent reply",
  async () =>
    withPanel(
      "panels/chat",
      async (handle) => {
        await waitForText(handle, INITIAL_PROMPT, { timeoutMs: 60_000 });
        // The eval invocation bead must reach "complete" (it may already be
        // complete by the first observation — pending is transient).
        await waitFor(
          () =>
            evalInPanel<boolean>(
              handle,
              `Boolean(document.querySelector('[data-invocation-name="eval"][data-invocation-status="complete"]'))`
            ),
          { timeoutMs: 60_000, label: "eval bead complete" }
        );
        await waitForText(handle, AGENT_REPLY, { timeoutMs: 60_000 });

        const finalText = await panelText(handle);
        expect(finalText, "tool bead label").toContain("Eval");
        expect(finalText, "raw tool-call leakage").not.toContain("[tool call:");
        expect(finalText, "raw eval console leakage").not.toContain("[eval] Console:");
        expect(finalText, "raw result JSON leakage").not.toContain('{"ok":true}');
      },
      { stateArgs: CHAT_STATE_ARGS }
    )
);
