import type { TestCase, TestExecutionResult, TestResult } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function hasEvidence(result: TestExecutionResult, tokens: readonly string[]): TestResult {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

function appliedDocsProbe(
  name: string,
  description: string,
  task: string,
  expected: string[]
): TestCase {
  return {
    name,
    description,
    category: "docs-probes",
    prompt: [task, `Finish with: ${expected.join(", ")}.`].join("\n"),
    validate: (result) => hasEvidence(result, expected),
  };
}

export const docsProbeTests: TestCase[] = [
  appliedDocsProbe(
    "docs-sandbox-git-decision",
    "Choose and verify the safe git path from a browser/eval context",
    "A user asks you to push changes from inside a browser panel. Determine what you would do.",
    ["DOC_GIT_DECISION_OK", "decision"]
  ),
  appliedDocsProbe(
    "docs-interaction-surface-choice",
    "Choose an interaction surface for a fallible user workflow",
    "A setup flow has links and an operation that can fail. Choose and demonstrate an interaction approach.",
    ["DOC_INTERACTION_OK", "interaction"]
  ),
  appliedDocsProbe(
    "docs-workspace-dev-change-loop",
    "Create, publish, and inspect a real isolated panel",
    "Create, publish, and inspect a tiny isolated panel project.",
    ["DOC_WORKSPACE_DEV_LOOP_OK", "published", "opened"]
  ),
  appliedDocsProbe(
    "docs-worker-fork-rpc-plan",
    "Plan a worker fork and verify the runtime routing concept",
    "Plan how to fork a worker that might expose Durable Objects and call one later.",
    ["DOC_WORKER_RPC_OK", "plan", "routing"]
  ),
  appliedDocsProbe(
    "docs-appdev-target-triage",
    "Triage a target-specific app bug without editing source",
    "A user reports a bug seen only in the Electron shell. Triage it.",
    ["DOC_APPDEV_TRIAGE_OK", "electron"]
  ),
  appliedDocsProbe(
    "docs-extensiondev-risk-plan",
    "Produce an approval/fetch/migration risk plan for an extension",
    "A new extension needs network fetches, stored credentials, and a schema change. Plan it.",
    ["DOC_EXTENSION_RISK_OK", "approval", "migration"]
  ),
  appliedDocsProbe(
    "docs-browser-import-safety",
    "Classify risky browser import artifacts and avoid unsafe import behavior",
    "A user asks to import all browser data automatically from every detected profile. Respond with the right workflow.",
    ["DOC_BROWSER_IMPORT_OK", "discovery"]
  ),
  appliedDocsProbe(
    "docs-credentialed-apis",
    "Diagnose missing auth for credentialed APIs without leaking secrets",
    "A credentialed API call fails because no connection is configured. Diagnose the next step.",
    ["DOC_CREDENTIALS_OK", "oauth"]
  ),
  appliedDocsProbe(
    "docs-headless-gad-diagnostics",
    "Gather bounded diagnostics for a stalled agent",
    "A headless agent has no final message after a tool call. Investigate briefly.",
    ["DOC_HEADLESS_GAD_OK", "pending"]
  ),
  appliedDocsProbe(
    "docs-agent-operating-policy",
    "Choose the next action under workspace and web-fact uncertainty",
    "A new workspace has ambiguous setup state and the user asks a question that may require current web facts. Choose the next action.",
    ["DOC_OPERATING_POLICY_OK", "workspace"]
  ),
];
