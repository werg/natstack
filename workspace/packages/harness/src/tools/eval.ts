/**
 * Eval tool — runs code in the agent's own server-side EvalDO via the `eval` service
 * (owner = the agent's verified identity). Replaces the former panel-advertised `eval`
 * channel method: it's a LOCAL agent tool, so the loop dispatches it in-process (the
 * EvalDO runs the code, not the panel). REPL scope + a synchronous SQLite `db` persist
 * in the EvalDO across calls.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";

const evalCommonSchema = {
  syntax: Type.Optional(
    Type.Union([Type.Literal("typescript"), Type.Literal("jsx"), Type.Literal("tsx")], {
      description: "Source syntax (default: tsx).",
    })
  ),
  imports: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description:
        'On-demand packages, e.g. { "lodash": "npm:^4.17.21" }. Workspace packages auto-resolve.',
    })
  ),
};

const evalSchema = Type.Union(
  [
    Type.Object(
      {
        ...evalCommonSchema,
        code: Type.String({
          description: "TypeScript/JavaScript to execute in the sandbox.",
        }),
        path: Type.Optional(Type.Never()),
      },
      { additionalProperties: false }
    ),
    Type.Object(
      {
        ...evalCommonSchema,
        path: Type.String({
          description: "Context-relative .ts/.tsx file to execute instead of inline code.",
        }),
        code: Type.Optional(Type.Never()),
      },
      { additionalProperties: false }
    ),
  ],
  { description: "Execute exactly one code string or context-relative path." }
);

export type EvalToolInput = Static<typeof evalSchema>;

export interface EvalRunResult {
  success: boolean;
  console: string;
  returnValue?: unknown;
  error?: string;
  scopeKeys?: string[];
}

/**
 * Format an `EvalRunResult` into the agent-visible tool result (windowing large console/return so a
 * runaway eval can't blow the agent's context). Shared by the tool's synchronous `execute` and the
 * agent's DEFERRED resume (`onEvalComplete`), so both produce identical output.
 */
export function formatEvalResult(result: EvalRunResult): AgentToolResult<EvalRunResult> {
  const parts: string[] = [];
  if (!result.success) parts.push(`[eval] Error: ${result.error ?? "unknown error"}`);
  if (result.console) {
    parts.push(`[eval] Console:\n${clampText(result.console, MAX_CONSOLE_CHARS, "$lastConsole")}`);
  }
  if (result.success && result.returnValue !== undefined) {
    parts.push(
      `[eval] Return value:\n${clampText(safeStringify(result.returnValue), MAX_RETURN_CHARS, "$lastReturn")}`
    );
  }
  const keys = result.scopeKeys ?? [];
  parts.push(
    keys.length ? `[scope] keys: ${keys.join(", ")} (${keys.length} total)` : "[scope] (empty)"
  );
  return {
    content: [{ type: "text", text: parts.join("\n") || "[eval] (no output)" }],
    details: result,
  } as AgentToolResult<EvalRunResult>;
}

export function createEvalTool(
  callMain: <T>(method: string, args: unknown[]) => Promise<T>,
  opts: { subKey?: string } = {}
): AgentTool<typeof evalSchema> {
  return {
    name: "eval",
    label: "eval",
    description:
      "Execute TypeScript/JS in your persistent sandbox (a per-agent EvalDO). REPL scope persists across calls via `scope`; a synchronous in-DO SQLite `db` is available; call workspace services via `rpc`/`services`; `return` sends a bounded value back; console output is captured. Very large console/return payloads are windowed with recovery pointers to `scope.$lastConsole` / `scope.$lastReturn`, so prefer returning compact summaries and store large artifacts in scope/blobstore.",
    parameters: evalSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<EvalRunResult>> => {
      if ((params.code === undefined) === (params.path === undefined)) {
        throw new Error("eval requires exactly one of code or path");
      }
      const result = await callMain<EvalRunResult>("eval.run", [
        {
          subKey: opts.subKey,
          // The agent's eval subKey IS its channelId — thread it through so the
          // service can give the sandbox a `chat` binding proxied to this agent.
          channelId: opts.subKey,
          code: params.code,
          path: params.path,
          syntax: params.syntax,
          imports: params.imports,
        },
      ]);
      // Formatting (with large-output windowing) is shared with the agent's deferred resume.
      return formatEvalResult(result);
    },
  };
}

// Catastrophe safety-net ONLY — a runaway eval that returns hundreds of KB
// would blow the agent's context or trip the RPC body cap. These are deliberately
// generous (~25k tokens/section): normal grep/typecheck/diagnostic output passes
// through untouched; only pathological dumps are windowed. (The richer original
// behavior — spill to blobstore/scope — is a separate follow-up.)
const MAX_CONSOLE_CHARS = 100_000;
const MAX_RETURN_CHARS = 100_000;

/**
 * Window to `max` chars (head+tail) with an actionable notice of how much was
 * elided and where to recover the full value: `scopeKey` is the persistent-scope
 * key the EvalDO stashed a bounded full copy under, page/grep it in a follow-up eval.
 */
function clampText(text: string, max: number, scopeKey: string): string {
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  const elided = text.length - max;
  return (
    `${text.slice(0, head)}\n` +
    `…[eval output truncated — ${elided} of ${text.length} chars elided. The full value is in ` +
    `\`scope.${scopeKey}\` — read it in pages (e.g. \`return scope.${scopeKey}.slice(0, 40000)\`) ` +
    `or grep it. Or narrow the eval.]…\n` +
    `${text.slice(-tail)}`
  );
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}
