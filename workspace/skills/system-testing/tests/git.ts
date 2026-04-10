import type { TestCase } from "../types.js";
import { findLastAgentMessage } from "./_helpers.js";

const gitHint = `Use GitClient from @natstack/git with fs and gitConfig from @workspace/runtime. Do NOT use node:child_process or shell commands. Example:\nimport { fs, gitConfig } from "@workspace/runtime";\nimport { GitClient } from "@natstack/git";\nconst git = new GitClient(fs, { serverUrl: gitConfig.serverUrl, token: gitConfig.token });`;

export const gitTests: TestCase[] = [
  {
    name: "init-commit",
    description: "Initialize a git repo, create a file, and commit",
    category: "git",
    prompt: `Initialize a new git repo at /test-repo, create a file, and commit it. Tell me the commit hash.\n\n${gitHint}\nKey methods: git.init(dir, branch), fs.writeFile(path, content), git.addAll(dir), git.commit({ dir, message })`,
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
    prompt: `In a git repo at /test-repo, create a new branch called "feature", switch to it, and make a commit. Tell me the branch name.\n\n${gitHint}\nKey methods: git.init(dir, branch), git.createBranch(dir, name), git.checkout(dir, name), git.commit({ dir, message })`,
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
    prompt: `Create a git repo at /test-repo, commit a file, then modify it and check the status. Tell me what changed.\n\n${gitHint}\nKey methods: git.init(dir, branch), git.status(dir) returns an array of file statuses`,
    validate: (result) => {
      const msg = findLastAgentMessage(result);
      const lower = msg.toLowerCase();
      const hasChange = lower.includes("modified") || lower.includes("changed") || lower.includes("diff") ||
        lower.includes("added") || lower.includes("removed") || lower.includes("status");
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
    prompt: `Create a git repo at /test-repo, make 3 commits with different messages, then show the log. Tell me the commit messages.\n\n${gitHint}\nKey methods: git.init(dir, branch), git.commit({ dir, message }), git.log(dir) returns commit history`,
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
    prompt: `Create a git repo at /test-repo, commit a file, modify it, stash the changes, verify the working tree is clean, then pop the stash. Tell me what happened at each step.\n\n${gitHint}\nKey methods: git.stash(dir), git.status(dir), git.stashPop(dir)`,
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
    prompt: `Create a git repo at /test-repo, add a remote pointing to the workspace git server, commit a file, and push. Report the result.\n\n${gitHint}\nKey methods: git.addRemote(dir, "origin", dir), git.push({ dir, ref: "main" }). The git server URL comes from gitConfig.serverUrl.`,
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
