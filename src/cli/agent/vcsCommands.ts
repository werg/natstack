import type {
  BuildDiagnostic,
  RepoBuildReport,
  VcsApplyEditsInput,
  VcsCommitResult,
  VcsDeleteRepoResult,
  VcsEditResult,
  VcsPushResult,
  VcsPushStatus,
  VcsRepoDivergence,
  VcsRestoreRepoResult,
  VcsStatusResult,
} from "@natstack/shared/serviceSchemas/vcs";
import {
  JSON_FLAG,
  type CliCommand,
  type FlagSpec,
  type ParsedInvocation,
} from "../commandTable.js";
import { EXIT_ERROR, jsonMode, printError, printResult, UsageError } from "../output.js";
import { resolveSessionScope, SESSION_FLAG } from "./sessionContext.js";

/**
 * `natstack vcs ...` — per-repo GAD-native version control.
 *
 * In the per-repo VCS model each workspace repo (`packages/foo`, `panels/chat`,
 * `projects/vault`, the flat `meta` repo) is a first-class versioned unit with
 * its own log (`vcs:repo:<repoPath>`), `main` head, and `ctx:*` context heads.
 * These commands operate on the attached agent session's per-repo context heads
 * and advance `main` only through the **build-gated** `vcs.push`.
 *
 * The model is **edit → commit → push**. `vcs edit` records uncommitted working
 * changes (no build); `vcs commit -m` folds them into a messaged snapshot per
 * repo; `vcs push --repo <p>` build-gates that snapshot into `main`. A push that
 * comes back `build-failed` did NOT advance `main` (read the structured
 * diagnostics, fix the cited `file:line:col`, re-push); a push that comes back
 * `diverged` means `main` moved past your base — `vcs merge` to reconcile, then
 * push. Only conflicting merges need a follow-up commit after marker resolution.
 */

const REPO_FLAG: FlagSpec = {
  name: "repo",
  takesValue: true,
  multiple: true,
  description: "Repo path to scope the operation to (e.g. panels/notes); repeatable for push",
};

const MESSAGE_FLAG: FlagSpec = {
  name: "message",
  short: "m",
  takesValue: true,
  description: "Commit message (required for `commit`; optional log summary for `push`)",
};

const FORCE_FLAG: FlagSpec = {
  name: "force",
  takesValue: false,
  description: "Delete even when other repos depend on this one (their builds may break)",
};

// ----- CLI-local response shapes -----
// The push-contract types (BuildDiagnostic / RepoBuildReport / VcsPushResult,
// incl. VcsRepoDivergence) are imported from the canonical zod schema in
// @natstack/shared/serviceSchemas/vcs so they cannot drift from the server.

interface RepoLogEntry {
  seq: number;
  envelopeId: string;
  actor: unknown;
  summary: string | null;
  outputStateHash: string | null;
  appendedAt: string;
}

// ----- repo-path parsing -----

function normalizeRepoPath(repo: string): string {
  return repo
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

/** First `--repo` (or first positional) for single-repo commands. */
function requireRepo(inv: ParsedInvocation): string {
  const repo = typeof inv.flags["repo"] === "string" ? inv.flags["repo"] : inv.positionals[0];
  if (!repo) {
    throw new UsageError("missing repo path — pass --repo REPOPATH (e.g. --repo panels/notes)");
  }
  return normalizeRepoPath(repo);
}

/**
 * Every `--repo` value (repeatable) plus any positionals, deduped in order.
 * Two or more repos form an **atomic group push** — all advance or none do.
 */
function collectRepos(inv: ParsedInvocation): string[] {
  const repos: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const repo = normalizeRepoPath(raw);
    if (repo && !seen.has(repo)) {
      seen.add(repo);
      repos.push(repo);
    }
  };
  for (const value of inv.flagsMulti("repo")) add(value);
  for (const positional of inv.positionals) add(positional);
  if (repos.length === 0) {
    throw new UsageError(
      "missing repo path — pass --repo REPOPATH (repeat --repo for an atomic group push)"
    );
  }
  return repos;
}

function headForContext(contextId: string): string {
  return `ctx:${contextId}`;
}

function formatNameStatus(s: VcsStatusResult): string {
  return [
    ...s.added.map((p) => `A\t${p}`),
    ...s.changed.map((p) => `M\t${p}`),
    ...s.removed.map((p) => `D\t${p}`),
  ].join("\n");
}

// ----- diagnostic rendering (W6.5 delivery surface) -----

/**
 * Render every report's diagnostics grouped by file as
 * `file:line:col  severity  message`, with `lineText`/`suggestion` indented
 * underneath when present. This is the agent's actionable error list.
 */
function printReportDiagnostics(reports: RepoBuildReport[]): void {
  const byFile = new Map<string, BuildDiagnostic[]>();
  let total = 0;
  for (const report of reports) {
    for (const build of report.builds) {
      for (const diag of build.diagnostics) {
        total += 1;
        const list = byFile.get(diag.file) ?? [];
        list.push(diag);
        byFile.set(diag.file, list);
      }
    }
  }
  if (total === 0) {
    // No diagnostics but a failing status — surface the failed repos so the
    // agent still knows where to look.
    const failed = reports.filter((r) => r.status === "failed").map((r) => r.repoPath);
    if (failed.length > 0) {
      console.error(`build failed in: ${failed.join(", ")} (no structured diagnostics emitted)`);
    }
    return;
  }
  for (const [file, diags] of byFile) {
    diags.sort((a, b) => (a.line ?? 1) - (b.line ?? 1) || (a.column ?? 1) - (b.column ?? 1));
    for (const diag of diags) {
      const line = diag.line ?? 1;
      const column = diag.column ?? 1;
      const loc = `${file}:${line}:${column}`;
      console.error(`${loc}  ${diag.severity}  [${diag.source}] ${diag.message}`);
      if (diag.lineText) console.error(`    ${diag.lineText.trim()}`);
      if (diag.suggestion) console.error(`    suggestion: ${diag.suggestion}`);
    }
  }
  const errors = total;
  console.error(`\n${errors} diagnostic${errors === 1 ? "" : "s"} across ${byFile.size} file(s).`);
}

function summarizeReports(reports: RepoBuildReport[]): void {
  for (const report of reports) {
    const counts = report.builds.reduce(
      (acc, build) => {
        for (const diag of build.diagnostics) {
          if (diag.severity === "error") acc.errors += 1;
          else acc.warnings += 1;
        }
        return acc;
      },
      { errors: 0, warnings: 0 }
    );
    const role = report.role === "pushed" ? "pushed" : "dependent";
    const tail =
      counts.errors > 0 || counts.warnings > 0
        ? ` (${counts.errors} error(s), ${counts.warnings} warning(s))`
        : "";
    console.log(`  ${report.status.padEnd(8)} ${role.padEnd(9)} ${report.repoPath}${tail}`);
  }
}

// ----- commands -----

async function push(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repoPaths = collectRepos(inv);
    const { client, contextId } = resolveSessionScope(inv);
    const sourceHead = headForContext(contextId);
    const message = typeof inv.flags["message"] === "string" ? inv.flags["message"] : undefined;

    const result = await client.call<VcsPushResult>("vcs.push", [
      { repoPaths, sourceHead, ...(message ? { message } : {}) },
    ]);

    if (json) {
      // Always emit the full discriminated union under --json.
      printResult(result, { json });
    } else {
      renderPushHuman(result, repoPaths);
    }

    // Non-zero exit on diverged / build-failed so scripts and agents can gate.
    if (result.status === "diverged" || result.status === "build-failed") {
      return EXIT_ERROR;
    }
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

function renderPushHuman(result: VcsPushResult, repoPaths: string[]): void {
  const group = repoPaths.length > 1 ? ` (group of ${repoPaths.length})` : "";
  switch (result.status) {
    case "pushed":
      console.log(`pushed ${result.repoPaths.join(", ")}${group}`);
      summarizeReports(result.reports);
      return;
    case "up-to-date":
      console.log(`up-to-date — nothing to push for ${result.repoPaths.join(", ")}`);
      return;
    case "diverged":
      renderDivergences(result.divergences);
      return;
    case "build-failed":
      console.error(
        `build-failed${group} — main did NOT advance. Fix the diagnostics and re-push:\n`
      );
      printReportDiagnostics(result.reports);
      return;
  }
}

/**
 * Fast-forward-only push rejected because `main` advanced past the context
 * head's merge-base. Print the upstream commits + whether a merge would be clean
 * or conflicting, then point at `vcs merge` to reconcile and re-push.
 */
function renderDivergences(divergences: VcsRepoDivergence[]): void {
  console.error("diverged — main advanced past your context's base; no head advanced.");
  for (const d of divergences) {
    const n = d.upstreamCommits.length;
    console.error(
      `\n  ${d.repoPath}: ${n} upstream commit(s) on main; merge would be ${d.mergeable}`
    );
    for (const c of d.upstreamCommits) {
      console.error(`    ${c.stateHash}  ${c.message}`);
    }
    if (d.mergeable === "conflict" && d.conflictPaths && d.conflictPaths.length > 0) {
      console.error(`    conflicting paths: ${d.conflictPaths.join(", ")}`);
    }
  }
  console.error(
    "\nReconcile with `natstack vcs merge --repo REPOPATH`, then push. " +
      "If the merge conflicts, resolve markers and commit before pushing."
  );
}

async function pushStatus(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repoPaths = collectRepos(inv);
    const { client } = resolveSessionScope(inv);
    const result = await client.call<VcsPushStatus[]>("vcs.pushStatus", [repoPaths]);
    printResult(result, {
      json,
      human: () => {
        for (const repo of result) {
          const blocked = repo.deleted || repo.diverged || repo.uncommitted > 0;
          if (repo.ahead === 0 && !blocked) {
            console.log(`${repo.repoPath}: clean (in sync with main)`);
            continue;
          }
          const parts: string[] = [];
          if (repo.deleted) parts.push("DELETED");
          if (repo.diverged) parts.push("diverged");
          if (repo.uncommitted > 0) {
            parts.push(`${repo.uncommitted} uncommitted working edit(s)`);
          }
          if (repo.ahead > 0) parts.push(`${repo.ahead} unpushed change(s)`);
          console.log(`${repo.repoPath}: ${parts.join(", ")}`);
          for (const file of repo.files) {
            console.log(`  ${file.kind}\t${file.path}`);
          }
          if (repo.uncommitted > 0) {
            console.log("  commit or discard uncommitted edits before push");
          }
          if (repo.diverged) {
            console.log("  merge/rebase this context before push");
          }
          if (repo.deleted) {
            console.log(
              "  repo was deleted from workspace main; restore it or drop/rebase this context"
            );
          }
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function status(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireRepo(inv);
    const { client, contextId } = resolveSessionScope(inv);
    const head = headForContext(contextId);
    // Per-repo native status: positional (repoPath, head). Returns the repo
    // subtree's added/removed/changed vs its own main via a CAS diff.
    const result = await client.call<VcsStatusResult>("vcs.status", [repo, head]);
    printResult(result, {
      json,
      human: () => {
        console.log(`repo: ${repo}`);
        console.log(`state: ${result.stateHash ?? "(none)"}`);
        if (result.deleted) {
          console.log("DELETED\trepo removed from workspace main; push will be refused");
        }
        if (!result.dirty && !result.deleted) {
          console.log("clean (in sync with main)");
          return;
        }
        if (result.uncommitted > 0) {
          console.log(`U\t${result.uncommitted} uncommitted working edit(s)`);
        }
        for (const p of result.added) console.log(`A\t${p}`);
        for (const p of result.changed) console.log(`M\t${p}`);
        for (const p of result.removed) console.log(`D\t${p}`);
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
    const head = headForContext(contextId);
    const statusResult = await client.call<VcsStatusResult>("vcs.status", [repo, head]);
    const result = formatNameStatus(statusResult);
    if (json) printResult(result, { json });
    else process.stdout.write(result ? `${result}\n` : "");
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function log(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireRepo(inv);
    const { client } = resolveSessionScope(inv);
    const limit = typeof inv.flags["limit"] === "string" ? Number(inv.flags["limit"]) : undefined;
    // Server log signature: (repoPath, limit?, head?). Scope to this repo.
    const result = await client.call<RepoLogEntry[]>("vcs.log", [
      repo,
      limit && Number.isFinite(limit) ? limit : undefined,
    ]);
    printResult(result, {
      json,
      human: () => {
        if (result.length === 0) {
          console.log(`no history for ${repo}`);
          return;
        }
        for (const entry of result) {
          const state = entry.outputStateHash ?? "(no-state)";
          console.log(`${state}  ${entry.appendedAt}  #${entry.seq}`);
          if (entry.summary) console.log(`    ${entry.summary}`);
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function forkRepo(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const from = inv.positionals[0];
    const to = inv.positionals[1];
    if (!from || !to) {
      throw new UsageError(
        "usage: natstack vcs fork-repo FROM_REPO TO_REPO (e.g. fork-repo panels/chat panels/mychat)"
      );
    }
    const { client } = resolveSessionScope(inv);
    const result = await client.call<{
      repoPath: string;
      head: string;
      inherited: number;
      stateHash: string;
    }>("vcs.forkRepo", [normalizeRepoPath(from), normalizeRepoPath(to)]);
    printResult(result, {
      json,
      human: () => {
        console.log(`forked ${normalizeRepoPath(from)} → ${result.repoPath}`);
        console.log(`  inherited ${result.inherited} commit(s) of history`);
        console.log(`  edit under ${result.repoPath}/ (package name already rewritten), then push`);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function deleteRepo(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireRepo(inv);
    const force = inv.flags["force"] === true;
    const { client } = resolveSessionScope(inv);
    // SEVERE: the server gates this behind explicit, per-repo user approval; the
    // call blocks until the user grants or denies (a denial surfaces as an error).
    // Without --force it ERRORS if other repos depend on this one.
    const result = await client.call<VcsDeleteRepoResult>("vcs.deleteRepo", [
      { repoPath: repo, ...(force ? { force: true } : {}) },
    ]);
    printResult(result, {
      json,
      human: () => {
        console.log(
          `deleted ${result.repoPath} — removed ${result.removedPaths.length} file(s) from workspace main`
        );
        if (result.archiveHead) {
          console.log(`  history archived at ${result.archiveHead} (recoverable)`);
        }
        if (result.dependents.length > 0) {
          console.log(
            `  ⚠ ${result.dependents.length} dependent repo(s) may now fail to build: ${result.dependents.join(", ")}`
          );
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function restoreRepo(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireRepo(inv);
    const { client } = resolveSessionScope(inv);
    // Blocks on user approval; fails if a different repo now occupies the path.
    const result = await client.call<VcsRestoreRepoResult>("vcs.restoreRepo", [{ repoPath: repo }]);
    printResult(result, {
      json,
      human: () => {
        console.log(
          `restored ${result.repoPath} — re-added ${result.restoredPaths.length} file(s) to workspace main`
        );
        if (result.fromArchiveHead) {
          console.log(`  recovered from archive ${result.fromArchiveHead}`);
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function contextStatus(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const { client } = resolveSessionScope(inv);
    const result = await client.call<
      Array<{
        repoPath: string;
        forked: boolean;
        uncommitted: boolean;
        ahead: boolean;
        behind: boolean;
        deleted: boolean;
      }>
    >("vcs.contextStatus", []);
    printResult(result, {
      json,
      human: () => {
        if (result.length === 0) {
          console.log("context clean — spans nothing beyond main, in sync");
          return;
        }
        for (const r of result) {
          const tags = [
            r.deleted && "DELETED",
            r.forked && "forked",
            r.uncommitted && "uncommitted",
            r.ahead && "ahead",
            r.behind && "behind",
          ]
            .filter(Boolean)
            .join(", ");
          console.log(`${r.repoPath}: ${tags}`);
        }
        if (result.some((r) => r.uncommitted)) {
          console.log(
            "\n`natstack vcs commit -m MESSAGE` to seal uncommitted edits (or `vcs discard`)."
          );
        }
        if (result.some((r) => r.deleted)) {
          console.log(
            "\nA repo your context references was DELETED from the workspace — a push will be " +
              "refused. Drop/rebase your context, or `natstack vcs restore-repo` to recover it."
          );
        }
        if (result.some((r) => r.behind)) {
          console.log("\n`natstack vcs rebase` to pull latest main into your context.");
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function rebase(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const { client } = resolveSessionScope(inv);
    const result = await client.call<{
      repos: Array<{ repoPath: string; status: "up-to-date" | "merged" | "conflicted" }>;
      baseView: string;
    }>("vcs.rebaseContext", []);
    printResult(result, {
      json,
      human: () => {
        for (const r of result.repos) console.log(`${r.status.padEnd(11)} ${r.repoPath}`);
        const conflicted = result.repos.filter((r) => r.status === "conflicted");
        if (conflicted.length > 0) {
          console.log(
            `\n${conflicted.length} repo(s) conflicted — resolve the markers, ` +
              "commit the resolution, then re-push."
          );
        } else {
          console.log("\ncontext rebased onto latest main.");
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Record UNCOMMITTED working edits on the context head (vcs.edit). The edit ops
 * are read as a JSON array from `--edits '<json>'` or stdin — each op is the
 * discriminated `{ kind, path, … }` shape (write/replace/create/delete/chmod),
 * with `{ path, content: "…" }` accepted shorthand for a write. This does NOT
 * commit, build, or advance the head; seal milestones with `vcs commit`.
 */
async function edit(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const raw =
      typeof inv.flags["edits"] === "string" ? inv.flags["edits"] : (await readStdin()).trim();
    if (!raw) {
      throw new UsageError(
        "no edits — pass --edits '<json array>' or pipe a JSON edit-op array on stdin"
      );
    }
    let edits: VcsApplyEditsInput["edits"];
    try {
      const parsed = JSON.parse(raw);
      edits = Array.isArray(parsed) ? parsed : parsed?.edits;
    } catch (parseError) {
      throw new UsageError(`--edits is not valid JSON: ${String(parseError)}`);
    }
    if (!Array.isArray(edits) || edits.length === 0) {
      throw new UsageError("edits must be a non-empty JSON array of edit ops");
    }
    const repo =
      typeof inv.flags["repo"] === "string" ? normalizeRepoPath(inv.flags["repo"]) : undefined;
    const { client, contextId } = resolveSessionScope(inv);
    const head = headForContext(contextId);
    const input: VcsApplyEditsInput = { edits, head, ...(repo ? { repoPath: repo } : {}) };
    const result = await client.call<VcsEditResult>("vcs.edit", [input]);
    printResult(result, {
      json,
      human: () => {
        console.log(
          `recorded ${result.changedPaths.length} working change(s) (uncommitted, editSeq ${result.editSeq})`
        );
        for (const p of result.changedPaths) console.log(`  ${p}`);
        console.log("seal with `natstack vcs commit -m MESSAGE`.");
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

/**
 * Fold the context's uncommitted working edits into ONE messaged snapshot per
 * repo (vcs.commit). `message` is mandatory; scope to repos with `--repo`
 * (repeatable) or omit to commit every repo the context has edits in.
 */
async function commit(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const message = typeof inv.flags["message"] === "string" ? inv.flags["message"] : undefined;
    if (!message) {
      throw new UsageError("commit requires a message — pass -m MESSAGE (or --message MESSAGE)");
    }
    const repoPaths = [...inv.flagsMulti("repo"), ...inv.positionals]
      .map(normalizeRepoPath)
      .filter(Boolean);
    const { client, contextId } = resolveSessionScope(inv);
    const head = headForContext(contextId);
    const result = await client.call<VcsCommitResult[]>("vcs.commit", [
      { message, head, ...(repoPaths.length > 0 ? { repoPaths } : {}) },
    ]);
    printResult(result, {
      json,
      human: () => {
        const committed = result.filter((r) => r.status === "committed");
        if (committed.length === 0) {
          console.log("nothing to commit — no uncommitted working edits.");
          return;
        }
        for (const r of committed) {
          console.log(`committed ${r.repoPath} — ${r.editCount} edit(s)`);
          for (const p of r.changedPaths) console.log(`  ${p}`);
        }
        console.log("\npush with `natstack vcs push --repo REPOPATH`.");
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

/**
 * Reconcile a repo with `main` (vcs.merge): pull main's commits into the context
 * head as a merge commit. A clean merge needs no resolution; a conflicting merge
 * materializes markers into the working tree — resolve with `vcs edit`, then
 * `vcs commit` seals it. After merging, the head fast-forwards on push.
 */
async function merge(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireRepo(inv);
    const { client, contextId } = resolveSessionScope(inv);
    const head = headForContext(contextId);
    const result = await client.call<{
      status: string;
      mergeable: "clean" | "conflict";
      upstreamCommits: Array<{ stateHash: string; message: string }>;
      conflictPaths?: string[];
    }>("vcs.merge", [repo, head]);
    printResult(result, {
      json,
      human: () => {
        const n = result.upstreamCommits.length;
        console.log(
          `merged ${repo}: pulled ${n} upstream commit(s) from main (${result.mergeable})`
        );
        for (const c of result.upstreamCommits) console.log(`  ${c.stateHash}  ${c.message}`);
        if (result.mergeable === "conflict") {
          console.log(
            `\nconflict markers written to: ${(result.conflictPaths ?? []).join(", ") || "(see status)"}`
          );
          console.log(
            "resolve them with `vcs edit`, then `vcs commit` to seal the merge, then push."
          );
        } else {
          console.log("\nclean merge committed — push now fast-forwards.");
        }
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

/**
 * Drop a repo's uncommitted working edits on the context head (vcs.discardEdits)
 * — and clear any in-progress merge — restoring the committed head on disk.
 */
async function discard(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const repo = requireRepo(inv);
    const { client, contextId } = resolveSessionScope(inv);
    const head = headForContext(contextId);
    const result = await client.call<{ discarded: number; stateHash: string }>("vcs.discardEdits", [
      repo,
      head,
    ]);
    printResult(result, {
      json,
      human: () => {
        console.log(`discarded ${result.discarded} uncommitted edit(s) in ${repo}`);
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

const EDITS_FLAG: FlagSpec = {
  name: "edits",
  takesValue: true,
  description: "JSON array of edit ops (omit to read the array from stdin)",
};

const LIMIT_FLAG: FlagSpec = {
  name: "limit",
  takesValue: true,
  description: "Maximum number of log entries to return",
};

export const vcsCommands: CliCommand[] = [
  {
    group: "vcs",
    name: "edit",
    summary: "Record uncommitted working edits on your context head (no commit, no build)",
    usage: "natstack vcs edit [--repo REPOPATH] --edits '<json>'  (or pipe JSON on stdin)",
    flags: [REPO_FLAG, EDITS_FLAG, SESSION_FLAG, JSON_FLAG],
    run: edit,
  },
  {
    group: "vcs",
    name: "commit",
    summary: "Fold your context's uncommitted working edits into one messaged snapshot per repo",
    usage: "natstack vcs commit -m MESSAGE [--repo REPOPATH ...]",
    flags: [REPO_FLAG, MESSAGE_FLAG, SESSION_FLAG, JSON_FLAG],
    run: commit,
  },
  {
    group: "vcs",
    name: "push",
    summary: "Build-gate a repo's context head into main (repeat --repo for an atomic group)",
    usage: "natstack vcs push --repo REPOPATH [--repo REPOPATH ...] [-m MESSAGE]",
    flags: [REPO_FLAG, MESSAGE_FLAG, SESSION_FLAG, JSON_FLAG],
    run: push,
  },
  {
    group: "vcs",
    name: "merge",
    summary: "Pull main into your context head (reconcile divergence before re-pushing)",
    usage: "natstack vcs merge --repo REPOPATH",
    flags: [REPO_FLAG, SESSION_FLAG, JSON_FLAG],
    run: merge,
  },
  {
    group: "vcs",
    name: "discard",
    summary: "Drop a repo's uncommitted working edits (and abort any in-progress merge)",
    usage: "natstack vcs discard --repo REPOPATH",
    flags: [REPO_FLAG, SESSION_FLAG, JSON_FLAG],
    run: discard,
  },
  {
    group: "vcs",
    name: "push-status",
    aliases: ["pushstatus"],
    summary: "Show how many changes each repo has ahead of main (pre-push)",
    usage: "natstack vcs push-status --repo REPOPATH [--repo REPOPATH ...]",
    flags: [REPO_FLAG, SESSION_FLAG, JSON_FLAG],
    run: pushStatus,
  },
  {
    group: "vcs",
    name: "status",
    summary: "Show a repo's unpushed changes (context head vs its main)",
    usage: "natstack vcs status --repo REPOPATH",
    flags: [REPO_FLAG, SESSION_FLAG, JSON_FLAG],
    run: status,
  },
  {
    group: "vcs",
    name: "diff",
    summary: "Show a name-status diff of a repo's unpushed changes",
    usage: "natstack vcs diff --repo REPOPATH",
    flags: [REPO_FLAG, SESSION_FLAG, JSON_FLAG],
    run: diff,
  },
  {
    group: "vcs",
    name: "log",
    summary: "Show a single repo's push history",
    usage: "natstack vcs log --repo REPOPATH [--limit N]",
    flags: [REPO_FLAG, LIMIT_FLAG, SESSION_FLAG, JSON_FLAG],
    run: log,
  },
  {
    group: "vcs",
    name: "fork-repo",
    summary: "Fork a repo to a new path, preserving its history (edit on top of the fork)",
    usage: "natstack vcs fork-repo FROM_REPO TO_REPO",
    flags: [SESSION_FLAG, JSON_FLAG],
    run: forkRepo,
  },
  {
    group: "vcs",
    name: "delete-repo",
    summary:
      "Permanently remove a repo from the workspace — archives its history, drops it from main (requires user approval; refuses if depended-on unless --force)",
    usage: "natstack vcs delete-repo --repo REPOPATH [--force]",
    flags: [REPO_FLAG, FORCE_FLAG, SESSION_FLAG, JSON_FLAG],
    run: deleteRepo,
  },
  {
    group: "vcs",
    name: "restore-repo",
    summary:
      "Recover a deleted repo from its archived history (fails if a different repo now occupies the path; requires user approval)",
    usage: "natstack vcs restore-repo --repo REPOPATH",
    flags: [REPO_FLAG, SESSION_FLAG, JSON_FLAG],
    run: restoreRepo,
  },
  {
    group: "vcs",
    name: "context-status",
    summary: "Show what your context has edited and how far it has drifted from main",
    usage: "natstack vcs context-status",
    flags: [SESSION_FLAG, JSON_FLAG],
    run: contextStatus,
  },
  {
    group: "vcs",
    name: "rebase",
    summary: "Pull latest main into your context (merge edited repos + re-pin base)",
    usage: "natstack vcs rebase",
    flags: [SESSION_FLAG, JSON_FLAG],
    run: rebase,
  },
];
