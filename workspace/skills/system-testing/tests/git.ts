import type { TestCase } from "../types.js";
import { findLastAgentMessage, responseContains, responseSucceeds } from "./_helpers.js";

export const gitTests: TestCase[] = [
  {
    name: "init-commit",
    description: "Initialize a git repo, create a file, and commit",
    category: "git",
    prompt: "Initialize a new git repo in a temp directory, create a file, add and commit it. Tell me the commit hash.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      // Commit hashes are hex strings of 7+ chars
      const hasHash = /[0-9a-f]{7,40}/i.test(msg);
      return {
        passed: hasHash,
        reason: hasHash ? undefined : `Expected a commit hash in response, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "branch-checkout",
    description: "Create and switch branches, make a commit, list branches",
    category: "git",
    prompt: "In a git repo, create a branch called 'feature', switch to it, make a commit, then list branches.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const hasFeature = msg.toLowerCase().includes("feature");
      return {
        passed: hasFeature,
        reason: hasFeature ? undefined : `Expected "feature" branch in response, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "diff-status",
    description: "Modify a file and check git status/diff",
    category: "git",
    prompt: "In a git repo, modify a tracked file and check the status and diff. Tell me what changed.",
    timeout: 45_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasChange = lower.includes("modified") || lower.includes("changed") || lower.includes("diff") ||
        lower.includes("status") || lower.includes("unstaged");
      return {
        passed: hasChange,
        reason: hasChange ? undefined : `Expected git status/diff info, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "log-history",
    description: "Make multiple commits and view the log",
    category: "git",
    prompt: "Create a git repo, make 3 commits with different messages, then show the log. Tell me all commit messages.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      // Should contain at least 2 distinct commit-like references
      const hasLog = lower.includes("commit") || lower.includes("log") || lower.includes("message");
      return {
        passed: hasLog,
        reason: hasLog ? undefined : `Expected commit log with messages, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "stash-pop",
    description: "Stash changes, verify clean state, then pop",
    category: "git",
    prompt: "In a git repo, modify a file, stash the changes, verify the file is clean, then pop the stash and verify the changes are back.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasStash = lower.includes("stash") || lower.includes("clean") || lower.includes("pop") || lower.includes("restore");
      return {
        passed: hasStash,
        reason: hasStash ? undefined : `Expected stash/pop workflow described, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "push-to-remote",
    description: "Push a commit to the workspace git server",
    category: "git",
    prompt: "Clone or init a repo, make a commit, and push to the workspace git server. Report the result.",
    timeout: 60_000,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasResult = lower.includes("push") || lower.includes("remote") || lower.includes("origin") ||
        lower.includes("error") || lower.includes("success") || lower.includes("reject");
      return {
        passed: hasResult,
        reason: hasResult ? undefined : `Expected push result or error, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];
