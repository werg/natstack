import type { TestCase } from "../types.js";
import {
  finalMessageHasAll,
  finalMessageHasNumericField,
  noIncompleteInvocations,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const workspaceTests: TestCase[] = [
  {
    name: "list-workspaces",
    description: "List all workspaces",
    category: "workspace",
    prompt: "Exercise workspace listing. Finish with WORKSPACE_LIST_OK and count=<number>.",
    validate: (result) => {
      const base = checked(result, ["WORKSPACE_LIST_OK"]);
      if (!base.passed) return base;
      return finalMessageHasNumericField(result, "count");
    },
  },
  {
    name: "get-active",
    description: "Get the current workspace info",
    category: "workspace",
    prompt: "Exercise active workspace inspection. Finish with WORKSPACE_ACTIVE_OK and context.",
    validate: (result) => checked(result, ["WORKSPACE_ACTIVE_OK", "context"]),
  },
  {
    name: "get-config",
    description: "Get workspace configuration",
    category: "workspace",
    prompt:
      "Exercise workspace configuration inspection. Finish with WORKSPACE_CONFIG_OK and facts:2.",
    validate: (result) => checked(result, ["WORKSPACE_CONFIG_OK", "facts:2"]),
  },
];
