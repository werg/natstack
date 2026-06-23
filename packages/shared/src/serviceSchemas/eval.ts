/**
 * Wire schema for the server "eval" service — owner-scoped sandbox eval backed by a
 * per-owner internal EvalDO. Replaces the former "scope" service: the EvalDO holds REPL
 * scope (and a user `db`) in its own SQLite, and runs code via the workerd UnsafeEval binding.
 *
 * The `objectKey` is derived server-side from `ctx.caller` (+ optional `subKey`), so a caller
 * can only ever address its own EvalDO — owner isolation is structural, no client-supplied key.
 */

import { z } from "zod";
import { defineServiceMethods } from "../typedServiceClient.js";

export const evalRunArgsSchema = z
  .object({
    /**
     * Privileged owner override for host surfaces. Shell/server callers use this to run
     * eval as an attached session entity instead of as the shell device itself.
     */
    ownerId: z.string().optional(),
    /** Context owned by `ownerId`; must match the active entity registry. */
    contextId: z.string().optional(),
    /** Logical sub-context name (default "default") — lets one owner keep multiple eval scopes. */
    subKey: z.string().optional(),
    /**
     * Channel the eval is bound to. When the caller is an agent DO and this is
     * set, the service threads it (with the agent's runtime id) into the EvalDO
     * so the sandbox gets a `chat` binding that proxies channel ops back to the
     * agent. Omitted for CLI/panel callers (they get no `chat`).
     */
    channelId: z.string().optional(),
    /** Inline code to execute (provide either `code` or `path`). */
    code: z.string().optional(),
    /** Context-relative TS/TSX file to execute instead of inline code. */
    path: z.string().optional(),
    syntax: z.enum(["typescript", "jsx", "tsx"]).optional(),
    /** On-demand package builds (e.g. { "lodash": "npm:^4.17.21" }). */
    imports: z.record(z.string()).optional(),
    /** Caller-supplied idempotency key (agents pass their raw invocationId). Defaults server-side. */
    runId: z.string().optional(),
    /** Opt-in deadline in ms; the run is aborted after this long. Absent ⇒ unbounded. */
    timeoutMs: z.number().int().positive().optional(),
    /** Read-only containment: every service call this run makes is dispatched with
     *  `ctx.readOnly`, so the server refuses any method not declared `sensitivity:"read"`. */
    readOnly: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasCode = value.code !== undefined;
    const hasPath = value.path !== undefined;
    if (hasCode === hasPath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "provide exactly one of code or path",
        path: hasCode ? ["path"] : ["code"],
      });
    }
    if ((value.ownerId === undefined) !== (value.contextId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ownerId and contextId must be provided together",
        path: value.ownerId === undefined ? ["ownerId"] : ["contextId"],
      });
    }
  });

export const evalRunResultSchema = z
  .object({
    success: z.boolean(),
    /** Formatted console output captured during the run. */
    console: z.string(),
    /** Safe-serialized return value (present on success). */
    returnValue: z.unknown().optional(),
    /** Error message (present on failure). */
    error: z.string().optional(),
    /** Keys currently held in the persistent REPL scope (for the agent's awareness). */
    scopeKeys: z.array(z.string()).optional(),
  })
  .strict();

/** Args for polling an async run: routing (owner/subKey, like `run`) + the runId. */
export const evalGetRunArgsSchema = z
  .object({
    ownerId: z.string().optional(),
    contextId: z.string().optional(),
    subKey: z.string().optional(),
    runId: z.string(),
  })
  .strict();

/** A run's status + (when terminal) its result. status ∈ pending|running|done|cancelled|unknown. */
export const evalRunStatusSchema = z
  .object({
    status: z.string(),
    result: evalRunResultSchema.optional(),
  })
  .strict();

export const evalResetArgsSchema = z
  .object({
    ownerId: z.string().optional(),
    contextId: z.string().optional(),
    subKey: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.ownerId === undefined) !== (value.contextId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ownerId and contextId must be provided together",
        path: value.ownerId === undefined ? ["ownerId"] : ["contextId"],
      });
    }
  });

/** Args for cancelling ONE run: routing (owner/subKey, like `reset`) + the runId to cancel. */
export const evalCancelArgsSchema = z
  .object({
    ownerId: z.string().optional(),
    contextId: z.string().optional(),
    subKey: z.string().optional(),
    runId: z.string(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.ownerId === undefined) !== (value.contextId === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ownerId and contextId must be provided together",
        path: value.ownerId === undefined ? ["ownerId"] : ["contextId"],
      });
    }
  });

export const evalMethods = defineServiceMethods({
  run: {
    args: z.tuple([evalRunArgsSchema]),
    returns: evalRunResultSchema,
    description:
      "Run TypeScript/JS in the caller's per-owner EvalDO sandbox (persistent REPL scope + synchronous in-DO SQLite `db`). Owner is the verified caller; fs is scoped to the owner's context.",
    access: { sensitivity: "write" },
  },
  reset: {
    args: z.tuple([evalResetArgsSchema]),
    returns: z.object({ ok: z.boolean() }).strict(),
    description:
      "Reset the eval context: wipe the persistent scope + the user `db` tables (a fresh scope), preserving the kernel's own state. The owner's existing data is cleared.",
    access: { sensitivity: "destructive" },
  },
  startRun: {
    args: z.tuple([evalRunArgsSchema]),
    returns: z.object({ runId: z.string() }).strict(),
    description:
      "Start an eval run for a caller that cannot hold a connection (an agent DO): returns a runId at once; the eval runs server-held in the EvalDO and the result is delivered out-of-band (onEvalComplete) and/or polled via getRun. Connection-holding callers (panels/CLI) should use `run` for a one-request result.",
    access: { sensitivity: "write" },
  },
  getRun: {
    args: z.tuple([evalGetRunArgsSchema]),
    returns: evalRunStatusSchema,
    description:
      "Poll an async run started with startRun: returns its status and (when done) result.",
    access: { sensitivity: "read" },
  },
  cancel: {
    args: z.tuple([evalCancelArgsSchema]),
    returns: z.object({ ok: z.boolean() }).strict(),
    description:
      "Cancel a single in-flight or pending run by runId (CAS to cancelled, then abort its outbound calls so a run wedged on an rpc.call unwinds). Other runs and the persistent scope are untouched. A no-op if the run is already terminal.",
    access: { sensitivity: "write" },
  },
  forceReset: {
    args: z.tuple([evalResetArgsSchema]),
    returns: z.object({ ok: z.boolean() }).strict(),
    description:
      "Forced recovery for a wedged eval DO: cancel every non-terminal run, abort all in-flight runs, and reset the eval context (wipe scope + user db) IMMEDIATELY without waiting on the stuck run chain. Use when `reset` itself would hang behind a wedged run.",
    access: { sensitivity: "destructive" },
  },
});
