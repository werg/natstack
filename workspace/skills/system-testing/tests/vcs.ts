import type { TestCase } from "../types.js";
import { finalMessageHasAll, noIncompleteInvocations } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  return noIncompleteInvocations(result);
}

export const vcsTests: TestCase[] = [
  {
    name: "vcs-status",
    description: "Inspect GAD workspace VCS status",
    category: "vcs",
    prompt:
      "Use the runtime vcs API to inspect workspace status for this context. Finish with VCS_STATUS_OK and dirty:<true-or-false>.",
    validate: (result) => checked(result, ["VCS_STATUS_OK", "dirty:"]),
  },
  {
    name: "vcs-commit-state",
    description: "Create a GAD workspace commit and report its state hash",
    category: "vcs",
    prompt:
      "Create a small temporary project file with vcs.applyEdits (edit-first: the write commits to your context head) and report the resulting state hash. Finish with VCS_COMMIT_OK and state:.",
    validate: (result) => checked(result, ["VCS_COMMIT_OK", "state:"]),
  },
  {
    name: "vcs-log-history",
    description: "Create multiple GAD commits and inspect the VCS log",
    category: "vcs",
    prompt:
      "Create two small temporary commits with vcs.applyEdits (each write commits to your context head), inspect vcs.log, and report the observed entries. Finish with VCS_LOG_OK and commits:2.",
    validate: (result) => checked(result, ["VCS_LOG_OK", "commits:2"]),
  },
  {
    name: "vcs-state-diff",
    description: "Diff two committed GAD states",
    category: "vcs",
    prompt:
      "Create two committed VCS states with vcs.applyEdits that differ by one temporary file edit, then compare them with vcs.diff. Finish with VCS_DIFF_OK and changed-path.",
    validate: (result) => checked(result, ["VCS_DIFF_OK", "changed-path"]),
  },
  {
    name: "vcs-apply-edits",
    description: "Apply an exact edit onto a pinned GAD base state",
    category: "vcs",
    prompt:
      "Read a temporary file with vcs.readFile, update it with vcs.applyEdits using the returned baseStateHash, and verify the new state. Finish with VCS_APPLY_EDITS_OK and state:.",
    validate: (result) => checked(result, ["VCS_APPLY_EDITS_OK", "state:"]),
  },
  {
    name: "vcs-publish-status",
    description: "Inspect unpublished context changes without moving main",
    category: "vcs",
    prompt:
      "Inspect unpublished context status with vcs.publishStatus without calling vcs.publish. Finish with VCS_PUBLISH_STATUS_OK and ahead:.",
    validate: (result) => checked(result, ["VCS_PUBLISH_STATUS_OK", "ahead:"]),
  },
];
