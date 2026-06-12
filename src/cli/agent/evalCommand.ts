/**
 * `natstack eval ...` — run TypeScript/JavaScript in a sandboxed child
 * process (dist/cli/eval-runner.mjs) against the paired server, with REPL
 * scope persisted server-side via the `scope` service.
 *
 * Code sources: FILE positional, `-e CODE`, or `-` (stdin).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "../commandTable.js";
import { loadCliCredentials } from "../credentialStore.js";
import {
  jsonMode,
  printError,
  printResult,
  CliError,
  TimeoutError,
  UsageError,
} from "../output.js";
import { resolveSessionScope, SESSION_FLAG } from "./sessionContext.js";
import type { EvalHandshake, ResultEvent, RunnerEvent } from "./evalRunner.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const SCOPE_PANEL_ID = "repl";

interface ScopeEntry {
  id: string;
  channelId: string;
  panelId: string;
  data: string;
  serializedKeys: string[];
  droppedPaths: Array<{ path: string; reason: string }>;
  partialKeys: string[];
  createdAt: number;
}

/** Scope channel for a session: one REPL scope per attached agent session. */
function scopeChannelId(scopeKey: string): string {
  return `cli:${scopeKey}`;
}

// ---------------------------------------------------------------------------
// Runner resolution + spawning
// ---------------------------------------------------------------------------

/**
 * Locate the eval-runner entry. Built CLI: dist/cli/eval-runner.mjs next to
 * client.mjs. Dev (tsx on src/): runs the TS source through the local tsx
 * install so the runner always matches the CLI code being executed — a
 * repo dist/ build may be stale. NATSTACK_EVAL_RUNNER overrides.
 */
export function resolveRunnerInvocation(): { command: string; args: string[] } {
  const override = process.env["NATSTACK_EVAL_RUNNER"];
  if (override) return { command: process.execPath, args: [override] };
  const here = path.dirname(fileURLToPath(import.meta.url));
  // Running from TS source (tsx dev mode): prefer the matching source runner
  // over any previously built dist (which may be stale).
  if (here.includes(`${path.sep}src${path.sep}`)) {
    const repoRoot = path.resolve(here, "..", "..", "..");
    const tsxCli = path.join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const runnerSource = path.join(repoRoot, "src", "cli", "agent", "evalRunner.ts");
    if (fs.existsSync(tsxCli) && fs.existsSync(runnerSource)) {
      return { command: process.execPath, args: [tsxCli, runnerSource] };
    }
  }
  const candidates = [
    path.join(here, "eval-runner.mjs"), // bundled: dist/cli/client.mjs sibling
    path.resolve(here, "..", "..", "..", "dist", "cli", "eval-runner.mjs"), // dev fallback: repo dist
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return { command: process.execPath, args: [candidate] };
  }
  throw new CliError(
    "eval runner not found — run `node build.mjs` to produce dist/cli/eval-runner.mjs"
  );
}

export interface RunnerOutcome {
  result: ResultEvent | null;
  consoleEvents: Array<Extract<RunnerEvent, { type: "console" }>>;
  timedOut: boolean;
  exitCode: number | null;
  stderr: string;
}

/**
 * Spawn the runner, deliver the handshake, and stream its NDJSON output.
 * Enforces the timeout with SIGKILL (the sandbox cannot preempt sync code).
 */
export function runEvalProcess(options: {
  invocation: { command: string; args: string[] };
  handshake: EvalHandshake;
  timeoutMs: number;
  onConsole?: (event: Extract<RunnerEvent, { type: "console" }>) => void;
}): Promise<RunnerOutcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(options.invocation.command, options.invocation.args, {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const outcome: RunnerOutcome = {
      result: null,
      consoleEvents: [],
      timedOut: false,
      exitCode: null,
      stderr: "",
    };
    const timer = setTimeout(() => {
      outcome.timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      outcome.stderr += chunk.toString("utf8");
    });
    const lines = readline.createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let event: RunnerEvent;
      try {
        event = JSON.parse(line) as RunnerEvent;
      } catch {
        return; // tolerate stray non-JSON output
      }
      if (event.type === "console") {
        outcome.consoleEvents.push(event);
        options.onConsole?.(event);
      } else if (event.type === "result") {
        outcome.result = event;
      }
    });
    // Settle once the process has exited AND stdout is fully drained, so a
    // result line racing process exit is never dropped.
    let exited = false;
    let streamDone = false;
    const maybeResolve = (): void => {
      if (exited && streamDone) resolve(outcome);
    };
    lines.on("close", () => {
      streamDone = true;
      maybeResolve();
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      outcome.exitCode = code;
      exited = true;
      maybeResolve();
    });

    child.stdin.on("error", () => {}); // runner may exit before reading stdin
    child.stdin.end(`${JSON.stringify(options.handshake)}\n`);
  });
}

// ---------------------------------------------------------------------------
// eval run
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function resolveCode(inv: ParsedInvocation): Promise<string> {
  const inline = typeof inv.flags["code"] === "string" ? inv.flags["code"] : undefined;
  const file = inv.positionals[0];
  if (inline !== undefined && file !== undefined) {
    throw new UsageError("-e CODE and FILE are mutually exclusive");
  }
  if (inline !== undefined) return inline;
  if (file === "-" || file === undefined) {
    if (file === undefined && process.stdin.isTTY) {
      throw new UsageError("missing code: pass FILE, -e CODE, or pipe code via stdin");
    }
    return await readStdin();
  }
  return await fs.promises.readFile(file, "utf8");
}

function parseTimeout(inv: ParsedInvocation): number {
  const raw = inv.flags["timeout"];
  if (typeof raw !== "string") return DEFAULT_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new UsageError("--timeout must be a positive integer (milliseconds)");
  }
  return value;
}

function parseImports(inv: ParsedInvocation): Record<string, string> | undefined {
  const raw = inv.flags["imports"];
  if (typeof raw !== "string") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UsageError('--imports must be a JSON object, e.g. {"lodash":"npm:4"}');
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new UsageError("--imports must be a JSON object");
  }
  return parsed as Record<string, string>;
}

function parseSyntax(inv: ParsedInvocation): "typescript" | "jsx" | "tsx" | undefined {
  const raw = inv.flags["syntax"];
  if (typeof raw !== "string") return undefined;
  if (raw !== "typescript" && raw !== "jsx" && raw !== "tsx") {
    throw new UsageError("--syntax must be one of: typescript, jsx, tsx");
  }
  return raw;
}

/**
 * Fail an eval run that produced no usable result (timeout, runner death).
 * In JSON mode the error document carries the collected console events and
 * trimmed runner stderr so hung evals stay debuggable; in text mode the
 * console output already streamed live, so just throw for printError.
 */
function failWithRunnerContext(error: CliError, outcome: RunnerOutcome, json: boolean): number {
  if (!json) throw error;
  const stderr = outcome.stderr.trim();
  console.error(
    JSON.stringify({
      error: error.message,
      exitCode: error.exitCode,
      console: outcome.consoleEvents,
      ...(stderr ? { stderr } : {}),
    })
  );
  return error.exitCode;
}

async function evalRun(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const code = await resolveCode(inv);
    const timeoutMs = parseTimeout(inv);
    const imports = parseImports(inv);
    const syntax = parseSyntax(inv);
    const { client, contextId, session } = resolveSessionScope(inv);
    const creds = loadCliCredentials();
    if (!creds) throw new CliError("not paired");
    // Reuse the client's shell token (one refresh) for both the scope RPC
    // calls below and the runner handshake.
    const shellToken = await client.getShellToken();
    const workspaceId = client.lastRefresh?.workspaceId;

    const channelId = scopeChannelId(session.scopeKey);
    const freshScope = inv.flags["fresh-scope"] === true;
    const previousEntry = freshScope
      ? null
      : await client.call<ScopeEntry | null>("scope.loadCurrent", [channelId, SCOPE_PANEL_ID]);

    const handshake: EvalHandshake = {
      code,
      syntax,
      imports,
      serverUrl: creds.url,
      shellToken,
      contextId,
      sessionId: session.entityId,
      workspaceId,
      scopeSnapshot: previousEntry?.data,
    };

    const outcome = await runEvalProcess({
      invocation: resolveRunnerInvocation(),
      handshake,
      timeoutMs,
      onConsole: json
        ? undefined
        : (event) => {
            const prefix = event.level === "log" ? "" : `[${event.level}] `;
            process.stderr.write(`${prefix}${event.text}\n`);
          },
    });

    if (outcome.timedOut) {
      return failWithRunnerContext(
        new TimeoutError(`eval timed out after ${timeoutMs}ms (runner killed)`),
        outcome,
        json
      );
    }
    const result = outcome.result;
    if (!result) {
      return failWithRunnerContext(
        new CliError(
          `eval runner exited (code ${outcome.exitCode}) without a result${
            outcome.stderr ? `: ${outcome.stderr.trim()}` : ""
          }`
        ),
        outcome,
        json
      );
    }

    // Persist the final scope under the same scope id. Skipped when the
    // result carries no scope (infrastructure failure before the sandbox ran)
    // or under --fresh-scope (a throwaway scope must not clobber the stored
    // one).
    const finalScope = result.scope;
    let scopeSaved = false;
    let scopeError: string | undefined;
    if (finalScope && !freshScope) {
      try {
        await client.call("scope.upsert", [
          {
            id: previousEntry?.id ?? randomUUID(),
            channelId,
            panelId: SCOPE_PANEL_ID,
            data: finalScope.json,
            serializedKeys: finalScope.serializedKeys,
            droppedPaths: finalScope.droppedPaths,
            partialKeys: finalScope.partialKeys,
            createdAt: previousEntry?.createdAt ?? Date.now(),
          } satisfies ScopeEntry,
        ]);
        scopeSaved = true;
      } catch (error) {
        scopeError = error instanceof Error ? error.message : String(error);
      }
    }
    const scopeWarnings = [
      ...(finalScope?.droppedPaths ?? []).map((d) => `scope: dropped ${d.path} (${d.reason})`),
      ...(scopeError ? [`scope: save failed: ${scopeError}`] : []),
    ];

    if (json) {
      printResult(
        {
          success: result.success,
          returnValue: result.returnValue,
          returnTruncated: result.returnTruncated ?? false,
          error: result.error,
          console: outcome.consoleEvents,
          scopeSaved,
          scopeWarnings,
        },
        { json: true }
      );
      return result.success ? 0 : 1;
    }

    for (const warning of scopeWarnings) process.stderr.write(`${warning}\n`);
    if (!result.success) {
      throw new CliError(result.error ?? "eval failed");
    }
    if (result.returnValue !== undefined) {
      printResult(result.returnValue, { json: false });
      if (result.returnTruncated) {
        process.stderr.write("(return value truncated at 256KB)\n");
      }
    }
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

// ---------------------------------------------------------------------------
// eval repl-reset
// ---------------------------------------------------------------------------

async function evalReplReset(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const { client, session } = resolveSessionScope(inv);
    const channelId = scopeChannelId(session.scopeKey);
    const scopeId = randomUUID();
    await client.call("scope.upsert", [
      {
        id: scopeId,
        channelId,
        panelId: SCOPE_PANEL_ID,
        data: "{}",
        serializedKeys: [],
        droppedPaths: [],
        partialKeys: [],
        createdAt: Date.now(),
      } satisfies ScopeEntry,
    ]);
    printResult(
      { reset: true, scopeId },
      { json, human: () => console.log(`scope reset for session ${session.name}`) }
    );
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

// ---------------------------------------------------------------------------
// Command table
// ---------------------------------------------------------------------------

export const evalCommands: CliCommand[] = [
  {
    group: "eval",
    name: "run",
    summary: "Run TS/JS in a sandbox against the paired server",
    usage: "natstack eval run [FILE | -e CODE | -] [--timeout MS] [--fresh-scope]",
    flags: [
      { name: "code", short: "e", takesValue: true, description: "Inline code" },
      {
        name: "timeout",
        takesValue: true,
        description: "Kill the runner after MS (default 120000)",
      },
      { name: "fresh-scope", takesValue: false, description: "Start from an empty REPL scope" },
      { name: "syntax", takesValue: true, description: "typescript | jsx | tsx (default tsx)" },
      {
        name: "imports",
        takesValue: true,
        description: 'JSON imports map, e.g. {"lodash":"npm:4"}',
      },
      SESSION_FLAG,
      JSON_FLAG,
    ],
    run: evalRun,
  },
  {
    group: "eval",
    name: "repl-reset",
    summary: "Reset the persistent REPL scope for a session",
    usage: "natstack eval repl-reset [--session NAME]",
    flags: [SESSION_FLAG, JSON_FLAG],
    run: evalReplReset,
  },
];
