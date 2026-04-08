import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

export const gitTests: TestCase[] = [
  {
    name: "init-commit",
    description: "Initialize a git repo, create a file, and commit",
    category: "git",
    prompt: "Initialize a new git repo, create a file, and commit it. Tell me the commit hash.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      // Commit hashes are hex strings of 7+ chars
      const hasHash = /[0-9a-f]{7,40}/i.test(msg);
      return {
        passed: hasHash,
        reason: hasHash ? undefined : `Expected a commit hash, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "branch-checkout",
    description: "Create and switch branches",
    category: "git",
    prompt: "In a git repo, create a new branch, switch to it, and make a commit. Tell me the branch name.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasBranch = lower.includes("branch") || lower.includes("switch") || lower.includes("checkout") || lower.includes("created");
      return {
        passed: hasBranch,
        reason: hasBranch ? undefined : `Expected branch info, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "diff-status",
    description: "Modify a file and check git status/diff",
    category: "git",
    prompt: "In a git repo, modify a tracked file and check the diff. Tell me what changed.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasChange = lower.includes("modified") || lower.includes("changed") || lower.includes("diff") ||
        lower.includes("added") || lower.includes("removed");
      return {
        passed: hasChange,
        reason: hasChange ? undefined : `Expected diff/change info, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "log-history",
    description: "Make multiple commits and view the log",
    category: "git",
    prompt: "Create a git repo, make a few commits, and show the log. Tell me the commit messages.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasLog = lower.includes("commit") || lower.includes("log") || lower.includes("message") || lower.includes("history");
      return {
        passed: hasLog,
        reason: hasLog ? undefined : `Expected commit log, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "stash-pop",
    description: "Stash changes, verify clean state, then pop",
    category: "git",
    prompt: "In a git repo, modify a file, stash the changes, verify the working tree is clean, then pop the stash. Tell me what happened at each step.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasStash = lower.includes("stash") || lower.includes("clean") || lower.includes("pop") || lower.includes("restore");
      return {
        passed: hasStash,
        reason: hasStash ? undefined : `Expected stash/pop workflow, got: ${msg.slice(0, 200)}`,
      };
    },
  },
  {
    name: "push-to-remote",
    description: "Push a commit to the workspace git server",
    category: "git",
    prompt: "Set up a repo and try to push a commit to the workspace git server. Report the result.",
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasResult = lower.includes("push") || lower.includes("remote") || lower.includes("origin") ||
        lower.includes("error") || lower.includes("success") || lower.includes("reject");
      return {
        passed: hasResult,
        reason: hasResult ? undefined : `Expected push result, got: ${msg.slice(0, 200)}`,
      };
    },
  },
];
