import type { TestCase } from "../types.js";
import { completedToolNames, finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function withNoPending(result: ReturnType<typeof finalMessageHasAll>, execution: Parameters<typeof noIncompleteInvocations>[0]) {
  if (!result.passed) return result;
  const pending = noIncompleteInvocations(execution);
  return pending.passed ? result : pending;
}

export const agenticRuntimeTests: TestCase[] = [
  {
    name: "state-args-immediate-snapshot",
    description: "Panel state changes are immediately observable",
    category: "agentic-runtime",
    prompt: "Check whether panel state changes are visible immediately in the same panel context. Finish with STATE_ARGS_OK and state-args-ok.",
    validate: (result) => withNoPending(finalMessageHasAll(result, ["STATE_ARGS_OK", "state-args-ok"]), result),
  },
  {
    name: "runtime-git-client-helper",
    description: "Git operations are usable from the runtime context",
    category: "agentic-runtime",
    prompt: "Check whether git operations are available from this runtime context. Finish with GIT_CLIENT_OK.",
    validate: (result) => withNoPending(finalMessageHasAll(result, ["GIT_CLIENT_OK"]), result),
  },
  {
    name: "gad-rawsql-positional-bindings",
    description: "GAD can run a small query",
    category: "agentic-runtime",
    prompt: "Run a tiny parameterized GAD query. Finish with GAD_RAWSQL_OK.",
    validate: (result) => withNoPending(finalMessageHasAll(result, ["GAD_RAWSQL_OK"]), result),
  },
  {
    name: "channel-envelope-inspection-bounded",
    description: "Channel history inspection stays usable",
    category: "agentic-runtime",
    prompt: "Inspect channel history for a harmless fake channel id. Finish with CHANNEL_INSPECT_OK and bounded.",
    validate: (result) => withNoPending(finalMessageHasAll(result, ["CHANNEL_INSPECT_OK", "bounded"]), result),
  },
  {
    name: "large-eval-result-terminal",
    description: "Large eval results complete visibly without leaving an invocation spinner pending",
    category: "agentic-runtime",
    prompt: "Create a large temporary value and report only a summary. Finish with LARGE_EVAL_OK and 2000.",
    validate: (result) => {
      const completed = completedToolNames(result);
      if (!completed.has("eval")) {
        return { passed: false, reason: `Expected completed eval tool call; completed tools: ${[...completed].join(", ") || "(none)"}` };
      }
      return withNoPending(finalMessageHasAll(result, ["LARGE_EVAL_OK", "2000"]), result);
    },
  },
  {
    name: "agent-debug-state-method",
    description: "Agent debug state is inspectable",
    category: "agentic-runtime",
    prompt: "Check whether this chat agent exposes debug state. Finish with DEBUG_STATE_OK or DEBUG_STATE_UNAVAILABLE.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["DEBUG_STATE_OK"]);
      if (ok.passed) return withNoPending(ok, result);
      return finalMessageHasAll(result, ["DEBUG_STATE_UNAVAILABLE"]);
    },
  },
  {
    name: "turn-no-silent-stall-after-tool",
    description: "A normal tool-using turn ends with a visible assistant response and no pending invocation",
    category: "agentic-runtime",
    prompt: "Use one tool, then produce a visible final response. Finish with NO_STALL_OK and final-response-visible.",
    validate: (result) => {
      const msg = finalMessageHasAll(result, ["NO_STALL_OK", "final-response-visible"]);
      return withNoPending(msg, result);
    },
  },
  {
    name: "workspace-test-runner-extension",
    description: "Agent runs workspace unit tests through the scoped test-runner extension",
    category: "agentic-runtime",
    prompt:
      "Use the supported workspace test runner extension from eval, not shell commands, to run the test file extensions/test-runner/index.test.ts. Report the structured result summary, passed count, failed count, and context id. Finish with WORKSPACE_TEST_RUNNER_OK and test-runner-extension.",
    validate: (result) => {
      const completed = completedToolNames(result);
      if (!completed.has("eval")) {
        return {
          passed: false,
          reason: `Expected a completed eval tool call; completed tools: ${[...completed].join(", ") || "(none)"}`,
        };
      }
      const msg = finalMessageHasAll(result, [
        "WORKSPACE_TEST_RUNNER_OK",
        "test-runner-extension",
      ]);
      return withNoPending(msg, result);
    },
  },
];
