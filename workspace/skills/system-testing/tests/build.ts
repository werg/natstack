import type { TestCase } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const buildTests: TestCase[] = [
  {
    name: "build-workspace-package",
    description: "Build a workspace package and verify success",
    category: "build",
    prompt: "Exercise building a workspace UI unit. Finish with BUILD_WORKSPACE_OK.",
    validate: (result) => checked(result, ["BUILD_WORKSPACE_OK"]),
  },
  {
    name: "build-npm-package",
    description: "Build an npm package and get a bundle",
    category: "build",
    prompt:
      "Exercise building or resolving a small pure-JavaScript npm dependency " +
      "(e.g. left-pad) that does not rely on Node.js built-in modules like " +
      "child_process/fs/os. Finish with BUILD_NPM_OK.",
    validate: (result) => checked(result, ["BUILD_NPM_OK"]),
  },
  {
    name: "build-at-ref",
    description: "Build a workspace package at a specific git ref",
    category: "build",
    prompt: "Exercise building a workspace unit at a git ref. Finish with BUILD_REF_OK or BUILD_REF_UNAVAILABLE.",
    validate: (result) => {
      const ok = finalMessageHasAll(result, ["BUILD_REF_OK"]);
      if (ok.passed) return noIncompleteInvocations(result);
      return checked(result, ["BUILD_REF_UNAVAILABLE"]);
    },
  },
  {
    name: "import-built-package",
    description: "Import a built package and inspect its exports",
    category: "build",
    prompt: "Exercise importing a workspace-built package. Finish with BUILD_IMPORT_OK.",
    validate: (result) => checked(result, ["BUILD_IMPORT_OK"]),
  },
];
