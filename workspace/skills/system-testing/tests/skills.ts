import type { TestCase } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const skillTests: TestCase[] = [
  {
    name: "load-sandbox",
    description: "Apply the sandbox skill to choose an execution surface",
    category: "skills",
    prompt:
      "Choose how to handle a one-off state inspection. Finish with SKILL_SANDBOX_OK and chosen-surface.",
    validate: (result) => checked(result, ["SKILL_SANDBOX_OK", "chosen-surface"]),
  },
  {
    name: "load-workspace-dev",
    description: "Apply the workspace-dev skill to choose a project workflow",
    category: "skills",
    prompt:
      "Choose a workflow for a requested panel change. Finish with SKILL_WORKSPACE_DEV_OK and workflow-choice.",
    validate: (result) => checked(result, ["SKILL_WORKSPACE_DEV_OK", "workflow-choice"]),
  },
  {
    name: "load-api-integrations",
    description: "Apply the API integrations skill to handle missing credentials",
    category: "skills",
    prompt:
      "Handle a missing credential for an API request. Finish with SKILL_API_OK and no-secret-paste.",
    validate: (result) => checked(result, ["SKILL_API_OK", "no-secret-paste"]),
  },
  {
    name: "load-headless-sessions",
    description: "Apply the headless-sessions skill to diagnose a stalled agent",
    category: "skills",
    prompt:
      "Diagnose a headless agent that used a tool but produced no final message. Finish with SKILL_HEADLESS_OK and bounded-diagnostics.",
    validate: (result) => checked(result, ["SKILL_HEADLESS_OK", "bounded-diagnostics"]),
  },
];
