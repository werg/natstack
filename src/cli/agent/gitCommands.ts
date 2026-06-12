import {
  JSON_FLAG,
  type CliCommand,
  type FlagSpec,
  type ParsedInvocation,
} from "../commandTable.js";
import { jsonMode, printError, printResult, UsageError } from "../output.js";
import { resolveSessionScope, SESSION_FLAG } from "./sessionContext.js";

/**
 * `natstack git ...` — git operations on a repo inside an agent session's
 * context folder, via the server git.context* methods. Shell callers pass
 * the contextId as the explicit first argument (same convention as fs.*).
 */

const REPO_FLAG: FlagSpec = {
  name: "repo",
  takesValue: true,
  description: "Workspace repo path inside the context (e.g. panels/notes)",
};

interface ContextRepoStatus {
  branch: string | null;
  commit: string | null;
  dirty: boolean;
  files: Array<{
    path: string;
    status: string;
    staged: boolean;
    unstaged: boolean;
  }>;
}

function requireRepo(inv: ParsedInvocation): string {
  const repo = typeof inv.flags["repo"] === "string" ? inv.flags["repo"] : inv.positionals[0];
  if (!repo) {
    throw new UsageError("missing repo path — pass --repo REPOPATH (e.g. --repo panels/notes)");
  }
  return repo;
}

async function status(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireRepo(inv);
    const { client, contextId } = resolveSessionScope(inv);
    const result = await client.call<ContextRepoStatus>("git.contextStatus", [contextId, repo]);
    printResult(result, {
      json,
      human: () => {
        console.log(`branch: ${result.branch ?? "(none)"}`);
        console.log(`commit: ${result.commit ?? "(none)"}`);
        if (result.files.length === 0) {
          console.log("clean");
          return;
        }
        for (const file of result.files) {
          const stage = file.staged ? "staged" : "unstaged";
          console.log(`${file.status}\t${file.path}\t(${stage})`);
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function diff(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireRepo(inv);
    const { client, contextId } = resolveSessionScope(inv);
    const result = await client.call<string>("git.contextDiff", [
      contextId,
      repo,
      { staged: inv.flags["staged"] === true },
    ]);
    if (json) printResult(result, { json });
    else process.stdout.write(result);
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function add(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireRepo(inv);
    if (inv.positionals.length > 1) {
      throw new UsageError(
        "git add stages ALL changes in the repo — per-file staging is not supported; drop the extra path arguments"
      );
    }
    const { client, contextId } = resolveSessionScope(inv);
    await client.call("git.contextAddAll", [contextId, repo]);
    printResult(
      { staged: repo },
      { json, human: () => console.log(`staged all changes in ${repo}`) }
    );
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function commit(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const message = typeof inv.flags["message"] === "string" ? inv.flags["message"] : undefined;
    if (!message || !message.trim()) {
      throw new UsageError("missing commit message — pass -m MSG");
    }
    const repo = requireRepo(inv);
    const { client, contextId } = resolveSessionScope(inv);
    const result = await client.call<{ commitId: string; summary: string }>("git.contextCommit", [
      contextId,
      repo,
      message,
    ]);
    printResult(result, {
      json,
      human: () => console.log(`${result.commitId.slice(0, 12)} ${result.summary}`),
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

export const gitCommands: CliCommand[] = [
  {
    group: "git",
    name: "status",
    summary: "Show working-tree status of a context repo",
    usage: "natstack git status --repo REPOPATH",
    flags: [REPO_FLAG, SESSION_FLAG, JSON_FLAG],
    run: status,
  },
  {
    group: "git",
    name: "diff",
    summary: "Show the working-tree (or staged) diff of a context repo",
    usage: "natstack git diff --repo REPOPATH [--staged]",
    flags: [
      {
        name: "staged",
        takesValue: false,
        description: "Diff the index instead of the working tree",
      },
      REPO_FLAG,
      SESSION_FLAG,
      JSON_FLAG,
    ],
    run: diff,
  },
  {
    group: "git",
    name: "add",
    summary: "Stage all changes in a context repo (git add -A)",
    usage: "natstack git add --repo REPOPATH",
    flags: [REPO_FLAG, SESSION_FLAG, JSON_FLAG],
    run: add,
  },
  {
    group: "git",
    name: "commit",
    summary: "Commit staged changes in a context repo",
    usage: "natstack git commit -m MSG --repo REPOPATH",
    flags: [
      { name: "message", short: "m", takesValue: true, description: "Commit message" },
      REPO_FLAG,
      SESSION_FLAG,
      JSON_FLAG,
    ],
    run: commit,
  },
];
