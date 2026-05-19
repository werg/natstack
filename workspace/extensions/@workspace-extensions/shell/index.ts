import * as path from "node:path";
import type { ExtensionContext } from "@natstack/extension";
import { buildExecApproval, buildOpenApproval } from "./approvals.js";
import { runExec } from "./exec.js";
import { SessionManager } from "./sessionManager.js";
import { execRequestSchema, openRequestSchema } from "./types.js";

const BLOCKED_ENV = /^(LD_PRELOAD|NODE_OPTIONS|PYTHONSTARTUP|SHELL)$|^DYLD_/;

function error(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function resolveWithin(root: string, input?: string): string {
  const resolved = path.resolve(root, input ?? ".");
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw error("EACCES", `Path escapes workspace root: ${input ?? "."}`);
  }
  return resolved;
}

function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "LANG", "TERM"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith("LC_") && value) env[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    if (!BLOCKED_ENV.test(key)) env[key] = value;
  }
  return env;
}

function currentOwner(ctx: ExtensionContext): { callerId: string; callerKind: string } {
  const caller = ctx.invocation.current()?.caller;
  if (!caller) throw error("ENOCALLER", "shell extension requires a panel or worker caller");
  return { callerId: caller.callerId, callerKind: caller.callerKind };
}

async function requireApproval(
  ctx: ExtensionContext,
  kind: "exec" | "open",
  req: ReturnType<typeof buildExecApproval> | ReturnType<typeof buildOpenApproval>,
): Promise<void> {
  const choice = await ctx.approvals.request(req);
  if (choice.kind === "uncallable") {
    throw error("ENOCALLER", "shell extension requires a panel or worker caller");
  }
  if (choice.kind === "dismissed") {
    throw error("EACCES", `shell.${kind} denied by user`);
  }
  if (choice.choice === "deny") {
    throw error("EACCES", `shell.${kind} denied by user`);
  }
}

export async function activate(ctx: ExtensionContext) {
  const workspace = await ctx.workspace.getInfo();
  const sessions = new SessionManager();
  if (sessions.ptyAvailable) {
    ctx.health.healthy({ summary: "Shell extension activated" });
  } else {
    ctx.health.degraded({
      summary: "Shell extension activated without node-pty",
      reasons: ["Interactive sessions use stdio fallback until node-pty is installed and built."],
    });
  }

  return {
    async exec(raw: unknown) {
      const parsed = execRequestSchema.parse(raw);
      const cwd = resolveWithin(workspace.path, parsed.cwd);
      const env = cleanEnv(parsed.env);
      const { env: _env, cwd: _cwd, ...execReq } = parsed;
      await requireApproval(ctx, "exec", buildExecApproval({
        command: parsed.command,
        args: parsed.args,
        cwd,
        shell: parsed.shell,
      }));
      return runExec({ ...execReq, cwd, env });
    },

    async open(raw: unknown) {
      const parsed = openRequestSchema.parse(raw);
      const cwd = resolveWithin(workspace.path, parsed.cwd);
      const command = parsed.command ?? process.env["SHELL"] ?? "/bin/bash";
      const env = cleanEnv(parsed.env);
      const { env: _env, cwd: _cwd, command: _command, ...openReq } = parsed;
      const owner = currentOwner(ctx);
      await requireApproval(ctx, "open", buildOpenApproval({
        command,
        args: parsed.args,
        cwd,
        label: parsed.label,
      }));
      return sessions.open({ ...openReq, command, cwd, env }, owner);
    },

    async write(sessionId: string, data: string) {
      sessions.write(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), data);
    },

    async resize(sessionId: string, cols: number, rows: number) {
      sessions.resize(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), cols, rows);
    },

    async kill(sessionId: string, signal?: "SIGINT" | "SIGTERM" | "SIGKILL" | "SIGHUP") {
      sessions.kill(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), signal ?? "SIGTERM");
    },

    async list() {
      return sessions.list(currentOwner(ctx).callerId);
    },

    async get(sessionId: string) {
      return sessions.info(sessions.requireOwner(sessionId, currentOwner(ctx).callerId));
    },

    async getSessionInfo(sessionId: string) {
      return sessions.info(sessions.requireOwner(sessionId, currentOwner(ctx).callerId));
    },

    async watchSessionInfo(sessionId: string) {
      return sessions.watchInfo(sessions.requireOwner(sessionId, currentOwner(ctx).callerId));
    },

    async attach(sessionId: string, opts?: { after?: string }) {
      return sessions.attach(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), opts);
    },

    async awaitExit(sessionId: string) {
      return sessions.awaitExit(sessions.requireOwner(sessionId, currentOwner(ctx).callerId));
    },

    async getScrollback(sessionId: string, maxBytes?: number) {
      return sessions.getScrollback(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), maxBytes);
    },
  };
}
