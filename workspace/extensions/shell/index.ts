import * as path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import type { ExtensionContext } from "@natstack/extension";
import { buildExecApproval, buildOpenApproval, buildUrlOpenApproval } from "./approvals.js";
import { runExec } from "./exec.js";
import { SessionManager } from "./sessionManager.js";
import { prepareVscodeShellIntegrationLaunch } from "./shellIntegrationEnv.js";
import { SnugServer } from "./snugServer.js";
import { nodeSetInterval } from "./nodeTimers.js";
import { execRequestSchema, openRequestSchema } from "./types.js";

const BLOCKED_ENV = /^(LD_PRELOAD|NODE_OPTIONS|PYTHONSTARTUP|SHELL)$|^DYLD_/;
const SCRATCH_LIMIT_BYTES = 25 * 1024 * 1024;
export const SCRATCH_TTL_MS = 24 * 60 * 60_000;
const SCRATCH_JANITOR_INTERVAL_MS = 30 * 60_000;

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

function normalizeScratchExt(ext: string): string {
  const clean = ext.replace(/^\./, "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(clean) ? clean : "bin";
}

function isReservedMetaKey(key: string): boolean {
  return key === "snugOpenUrl" || key === "snugSpawn";
}

function scratchFilename(ext: string): string {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const suffix = randomBytes(4).toString("hex");
  return `${stamp}-${suffix}.${normalizeScratchExt(ext)}`;
}

function currentOwner(ctx: ExtensionContext): { callerId: string; callerKind: string } {
  const caller = ctx.invocation.current()?.caller;
  if (!caller) throw error("ENOCALLER", "shell extension requires a panel or worker caller");
  return { callerId: caller.callerId, callerKind: caller.callerKind };
}

async function requireApproval(
  ctx: ExtensionContext,
  kind: "exec" | "open",
  req: ReturnType<typeof buildExecApproval> | ReturnType<typeof buildOpenApproval> | ReturnType<typeof buildUrlOpenApproval>,
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

/** Public API surface of this extension — the awaited return of {@link activate}. */
export type Api = Awaited<ReturnType<typeof activate>>;
declare module "@natstack/extension" {
  interface WorkspaceExtensions {
    "@workspace-extensions/shell": Api;
  }
}

export async function activate(ctx: ExtensionContext) {
  const workspace = await ctx.workspace.getInfo();
  let snug!: SnugServer;
  const sessions = new SessionManager({
    onExit: (sessionId) => snug.unregister(sessionId),
    onDispose: (sessionId) => snug.unregister(sessionId),
  });
  snug = new SnugServer({
    list: (ownerCallerId) => sessions.list(ownerCallerId),
    setMeta: (sessionId, key, value) => sessions.setMetaById(sessionId, key, value),
    getMeta: (sessionId, key) => sessions.getMetaById(sessionId, key),
    deleteMeta: (sessionId, key) => sessions.deleteMetaById(sessionId, key),
    setLabel: (sessionId, label) => sessions.setLabelById(sessionId, label),
    write: (sessionId, text) => sessions.writeById(sessionId, text),
    ownerOf: (sessionId) => sessions.ownerOf(sessionId),
    openSplit: async (sourceSessionId, direction, commandLine) => {
      const owner = sessions.ownerFor(sourceSessionId);
      if (!owner) throw error("ENOENT", "Unknown source session");
      const cwd = sessions.cwdOf(sourceSessionId) ?? workspace.path;
      const command = commandLine ? "/bin/sh" : process.env["SHELL"] ?? "/bin/bash";
      const args = commandLine ? ["-c", commandLine] : [];
      ctx.log.info?.("snug category-c request", { action: "split", sourceSessionId, direction, command, args, cwd, caller: owner.callerId });
      try {
        await requireApproval(ctx, "open", buildOpenApproval({ command, args, cwd, label: commandLine }));
      } catch (err) {
        ctx.log.info?.("snug category-c decision", { action: "split", sourceSessionId, decision: "deny", caller: owner.callerId, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      ctx.log.info?.("snug category-c decision", { action: "split", sourceSessionId, decision: "allow", caller: owner.callerId });
      const snugEnv = snug.envForSession(cleanEnv({}));
      try {
        const launch = await prepareVscodeShellIntegrationLaunch({
          command,
          args,
          env: snugEnv.env,
        });
        const result = sessions.open({
          command: launch.command,
          args: launch.args,
          cwd,
          env: launch.env,
          cols: 80,
          rows: 24,
          label: commandLine ?? "Shell",
        }, owner);
        snug.register(snugEnv.token, result.sessionId);
        sessions.setMetaById(result.sessionId, "snugSpawn", { parentSessionId: sourceSessionId, direction });
        return result.sessionId;
      } catch (err) {
        snug.discardPending(snugEnv.token);
        throw err;
      }
    },
    openUrl: async (_sessionId, url) => {
      if (!/^https?:\/\//.test(url)) throw error("EINVAL", "snug open only supports http(s) URLs");
      const owner = sessions.ownerFor(_sessionId);
      if (!owner) throw error("ENOENT", "Unknown source session");
      ctx.log.info?.("snug category-c request", { action: "open-url", sourceSessionId: _sessionId, url, caller: owner.callerId });
      try {
        await requireApproval(ctx, "open", buildUrlOpenApproval({ url }));
      } catch (err) {
        ctx.log.info?.("snug category-c decision", { action: "open-url", sourceSessionId: _sessionId, decision: "deny", caller: owner.callerId, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
      ctx.log.info?.("snug category-c decision", { action: "open-url", sourceSessionId: _sessionId, decision: "allow", caller: owner.callerId });
      sessions.setMetaById(_sessionId, "snugOpenUrl", { id: randomUUID(), url, requestedAt: Date.now() });
    },
  });
  await snug.start();
  const scratchDir = path.join(workspace.path, ".snug", "scratch");
  void sweepScratch(scratchDir);
  const scratchJanitor = nodeSetInterval(() => void sweepScratch(scratchDir), SCRATCH_JANITOR_INTERVAL_MS);
  scratchJanitor.unref?.();
  if (sessions.ptyAvailable) {
    ctx.health.healthy({ summary: "Shell extension activated" });
  } else {
    ctx.health.degraded({
      summary: "Shell extension activated without node-pty",
      reasons: ["Interactive terminal sessions require node-pty and cannot start until it is installed and built."],
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
      const { env: _env, cwd: _cwd, command: _command, ...openReq } = parsed;
      const owner = currentOwner(ctx);
      await requireApproval(ctx, "open", buildOpenApproval({
        command,
        args: parsed.args,
        cwd,
        label: parsed.label,
      }));
      const { env, token } = snug.envForSession(cleanEnv(parsed.env));
      try {
        const launch = await prepareVscodeShellIntegrationLaunch({
          command,
          args: parsed.args,
          env,
        });
        const result = sessions.open({
          ...openReq,
          command: launch.command,
          args: launch.args,
          cwd,
          env: launch.env,
        }, owner);
        snug.register(token, result.sessionId);
        return result;
      } catch (err) {
        snug.discardPending(token);
        throw err;
      }
    },

    async dispose(sessionId: string) {
      snug.unregister(sessionId);
      let session;
      try {
        session = sessions.requireOwner(sessionId, currentOwner(ctx).callerId);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
        throw err;
      }
      sessions.dispose(session);
    },

    async restart(sessionId: string, opts?: { cols?: number; rows?: number }) {
      const session = sessions.requireOwner(sessionId, currentOwner(ctx).callerId);
      const snugEnv = snug.envForSession(cleanEnv({}));
      try {
        const [command, ...args] = session.command.argv;
        const launch = await prepareVscodeShellIntegrationLaunch({
          command: command ?? process.env["SHELL"] ?? "/bin/bash",
          args,
          env: snugEnv.env,
        });
        const result = sessions.restart(session, {
          ...(opts?.cols ? { cols: opts.cols } : {}),
          ...(opts?.rows ? { rows: opts.rows } : {}),
          command: launch.command,
          args: launch.args,
          env: launch.env,
        });
        snug.register(snugEnv.token, result.sessionId);
        return result;
      } catch (err) {
        snug.discardPending(snugEnv.token);
        throw err;
      }
    },

    async write(sessionId: string, data: string) {
      sessions.write(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), data);
    },

    async acknowledgeDataEvent(sessionId: string, charCount: number) {
      sessions.acknowledgeDataEvent(
        sessions.requireOwner(sessionId, currentOwner(ctx).callerId),
        charCount
      );
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

    async watchAllSessionInfo() {
      return sessions.watchAllInfo(currentOwner(ctx).callerId);
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

    async setScrollbackLimit(sessionId: string, maxBytes: number) {
      sessions.setScrollbackLimit(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), maxBytes);
    },

    async clearScrollback(sessionId: string) {
      sessions.clearScrollback(sessions.requireOwner(sessionId, currentOwner(ctx).callerId));
    },

    async stashScratch(bytes: Uint8Array, ext: string) {
      currentOwner(ctx);
      const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (payload.byteLength === 0) throw error("EINVAL", "Cannot stash an empty file");
      if (payload.byteLength > SCRATCH_LIMIT_BYTES) throw error("E2BIG", "Scratch file exceeds 25MB limit");
      await mkdir(scratchDir, { recursive: true });
      const filename = scratchFilename(ext);
      const absolutePath = path.join(scratchDir, filename);
      await writeFile(absolutePath, payload);
      return { absolutePath, workspaceRelative: path.relative(workspace.path, absolutePath) };
    },

    async setMeta(sessionId: string, key: string, value: unknown) {
      if (isReservedMetaKey(key)) throw error("EACCES", `Reserved shell metadata key: ${key}`);
      sessions.setMeta(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), key, value);
    },

    async getMeta(sessionId: string, key?: string) {
      return sessions.getMeta(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), key);
    },

    async deleteMeta(sessionId: string, key: string) {
      if (isReservedMetaKey(key)) throw error("EACCES", `Reserved shell metadata key: ${key}`);
      sessions.deleteMeta(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), key);
    },

    async setLabel(sessionId: string, label: string) {
      sessions.setLabel(sessions.requireOwner(sessionId, currentOwner(ctx).callerId), label);
    },
  };
}

export async function sweepScratch(scratchDir: string, now = Date.now()): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(scratchDir);
  } catch {
    return;
  }
  const cutoff = now - SCRATCH_TTL_MS;
  await Promise.all(entries.map(async (entry) => {
    const absolutePath = path.join(scratchDir, entry);
    try {
      const info = await stat(absolutePath);
      if (info.isFile() && info.mtimeMs < cutoff) await unlink(absolutePath);
    } catch {
      // Best-effort cleanup only.
    }
  }));
}
