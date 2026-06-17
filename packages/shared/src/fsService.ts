/**
 * fsService — Server-side filesystem handler for panel RPC calls.
 *
 * Registered in the Electron main process dispatcher (not SERVER_SERVICES),
 * so panel fs.* calls route through Electron IPC where panel context
 * is available. In headless mode, registered in the server process dispatcher.
 *
 * All operations are sandboxed to the caller's context folder via path
 * validation and symlink traversal checks.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { randomBytes } from "node:crypto";
import type { FileHandle as NodeFileHandle } from "fs/promises";
import type { ServiceContext } from "./serviceDispatcher.js";
import type { ContextFolderManager } from "./contextFolderManager.js";
import { createDevLogger } from "@natstack/dev-log";
import { EntityCache } from "./runtime/entityCache.js";

const log = createDevLogger("FsService");

/** Idle timeout for open file handles (5 minutes). */
const HANDLE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Tracked file handle with cleanup metadata. */
interface TrackedHandle {
  handle: NodeFileHandle;
  panelId: string;
  timer: ReturnType<typeof setTimeout>;
}

interface FsCallScope {
  root: string;
  panelId: string;
  contextId?: string;
  unrestricted: boolean;
  exposeHostPaths: boolean;
}

interface ResolvedFsPath {
  path: string;
}

function codedError(code: string, message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

// ---------------------------------------------------------------------------
// Path sandboxing
// ---------------------------------------------------------------------------

/**
 * Resolve a user-provided path within a sandbox root, preventing traversal
 * and symlink-based escapes.
 */
async function sandboxPath(root: string, userPath: string): Promise<ResolvedFsPath> {
  const relative = userPath.startsWith("/") ? userPath.slice(1) : userPath;
  const resolved = path.resolve(root, relative);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error("Path traversal detected");
  }
  // Walk path components and check for symlinks in parents.
  let current = root;
  const segments = path.relative(root, resolved).split(path.sep);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      const st = await fs.lstat(current);
      if (st.isSymbolicLink()) {
        const target = await fs.realpath(current);
        if (!target.startsWith(root + path.sep) && target !== root) {
          throw new Error("Symlink escapes sandbox");
        }
      }
    } catch (e: any) {
      if (e.code === "ENOENT") break; // remainder doesn't exist yet
      if (e.message === "Symlink escapes sandbox") throw e;
      throw e;
    }
  }
  return { path: resolved };
}

async function resolveFsPathInfo(scope: FsCallScope, userPath: string): Promise<ResolvedFsPath> {
  if (!scope.unrestricted) {
    return sandboxPath(scope.root, userPath);
  }
  if (typeof userPath !== "string" || userPath.length === 0) {
    throw new Error("Path must be a non-empty string");
  }
  return { path: path.resolve(userPath) };
}

async function resolveFsPath(scope: FsCallScope, userPath: string): Promise<string> {
  return (await resolveFsPathInfo(scope, userPath)).path;
}

// ---------------------------------------------------------------------------
// Binary data encoding helpers (JSON RPC can't transport Uint8Array)
// ---------------------------------------------------------------------------

interface BinaryEnvelope {
  __bin: true;
  data: string; // base64
}

function isBinaryEnvelope(v: unknown): v is BinaryEnvelope {
  return (
    typeof v === "object" &&
    v !== null &&
    (v as any).__bin === true &&
    typeof (v as any).data === "string"
  );
}

function encodeBinary(buf: Buffer): BinaryEnvelope {
  return { __bin: true, data: buf.toString("base64") };
}

function decodeBinary(envelope: BinaryEnvelope): Buffer {
  return Buffer.from(envelope.data, "base64");
}

// ---------------------------------------------------------------------------
// GAD reroute — context source mutations commit through GAD, not raw disk
// ---------------------------------------------------------------------------

/** Write content for a GAD edit op (text, or base64 bytes). */
export type FsVcsContent = { kind: "text"; text: string } | { kind: "bytes"; base64: string };

/** The edit ops the fs reroute emits (a subset of the vcs edit-op union). */
export type FsVcsEditOp =
  | { kind: "write"; path: string; content: FsVcsContent; mode?: number }
  | { kind: "delete"; path: string }
  | { kind: "chmod"; path: string; mode: number };

/**
 * Bridge from the fs service to the workspace GAD VCS. When a sandboxed context
 * caller mutates a GAD-tracked path, the mutation commits through GAD
 * (`applyEdits`) — which advances the context head AND projects to disk —
 * rather than writing the worktree projection directly behind GAD's back.
 * Scratch/ignored paths (`.tmp`, `.testkit`, `node_modules`, `*.log`, …) are
 * not tracked and stay direct disk writes.
 */
export interface FsVcsBridge {
  /** True iff `relPath` is a GAD-trackable workspace path (what applyEdits accepts). */
  isTracked(relPath: string): Promise<boolean>;
  /** Commit edit ops to a context head (edit-first: also projects to disk). */
  applyEdits(
    contextId: string,
    edits: FsVcsEditOp[],
    actor: { id: string; kind: string }
  ): Promise<void>;
  /** Read a file's content at a context head; null if it does not exist there. */
  readFile(contextId: string, relPath: string): Promise<FsVcsContent | null>;
  /** List every tracked file path at a context head. */
  listFiles(contextId: string): Promise<string[]>;
}

function contentToBuffer(c: FsVcsContent): Buffer {
  return c.kind === "text" ? Buffer.from(c.text, "utf8") : Buffer.from(c.base64, "base64");
}

function dataToVcsContent(data: unknown): FsVcsContent {
  if (isBinaryEnvelope(data)) return { kind: "bytes", base64: data.data };
  return { kind: "text", text: data as string };
}

function appendVcsContent(existing: FsVcsContent | null, data: unknown): FsVcsContent {
  const add = dataToVcsContent(data);
  if (!existing) return add;
  if (existing.kind === "text" && add.kind === "text") {
    return { kind: "text", text: existing.text + add.text };
  }
  return {
    kind: "bytes",
    base64: Buffer.concat([contentToBuffer(existing), contentToBuffer(add)]).toString("base64"),
  };
}

function truncateVcsContent(existing: FsVcsContent | null, len: number): FsVcsContent {
  if (!existing) return { kind: "text", text: "" };
  const sliced = contentToBuffer(existing).subarray(0, Math.max(0, len));
  return existing.kind === "text"
    ? { kind: "text", text: sliced.toString("utf8") }
    : { kind: "bytes", base64: sliced.toString("base64") };
}

// ---------------------------------------------------------------------------
// Stat serialisation
// ---------------------------------------------------------------------------

function serializeStat(stats: fsSync.Stats) {
  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    isSymbolicLink: stats.isSymbolicLink(),
    size: stats.size,
    mtime: stats.mtime.toISOString(),
    ctime: stats.ctime.toISOString(),
    mode: stats.mode,
  };
}

function serializeDirent(d: fsSync.Dirent, name: string = d.name) {
  return {
    name,
    _isFile: d.isFile(),
    _isDirectory: d.isDirectory(),
    _isSymbolicLink: d.isSymbolicLink(),
  };
}

/** Path of a (possibly nested) Dirent relative to the listed directory. */
function relativeDirentName(listedDir: string, d: fsSync.Dirent): string {
  return path.relative(listedDir, path.join(d.parentPath, d.name)).split(path.sep).join("/");
}

// ---------------------------------------------------------------------------
// grep / glob
// ---------------------------------------------------------------------------

/** Directories never descended into by grep/glob. */
const SEARCH_SKIP_DIRS = new Set([".git", "node_modules"]);

const GREP_DEFAULT_MAX_MATCHES = 200;
const GREP_HARD_MAX_MATCHES = 1000;
const GREP_MAX_CONTEXT_LINES = 10;

export interface GrepOptions {
  /** Directory (or single file) to search, relative to the context root. */
  path?: string;
  /** Glob filter for candidate files (gitignore-style; basename match when slash-free). */
  glob?: string;
  caseInsensitive?: boolean;
  /** Lines of context before/after each match (clamped to 10). */
  contextLines?: number;
  /** Stop after this many matches (default 200, hard cap 1000). */
  maxMatches?: number;
}

export interface GlobOptions {
  /** Directory to search, relative to the context root. */
  path?: string;
}

export interface GrepMatch {
  file: string;
  lineNumber: number;
  line: string;
  before: string[];
  after: string[];
}

export interface GrepResult {
  matches: GrepMatch[];
  matchCount: number;
  truncated: boolean;
}

interface RawGrepMatch {
  /** Absolute file path. */
  file: string;
  lineNumber: number;
  line: string;
}

let cachedRipgrepPath: string | null | undefined;

/** Locate `rg` on PATH (cached). Exported test hook: `_resetRipgrepCache`. */
function findRipgrep(): string | null {
  if (cachedRipgrepPath !== undefined) return cachedRipgrepPath;
  const names = process.platform === "win32" ? ["rg.exe", "rg"] : ["rg"];
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      try {
        fsSync.accessSync(candidate, fsSync.constants.X_OK);
        if (fsSync.statSync(candidate).isFile()) {
          cachedRipgrepPath = candidate;
          return candidate;
        }
      } catch {
        // keep looking
      }
    }
  }
  cachedRipgrepPath = null;
  return null;
}

/** Test hook: force re-detection of ripgrep (and optionally disable it). */
export function _setRipgrepPathForTests(value: string | null | undefined): void {
  cachedRipgrepPath = value;
}

/**
 * Convert a glob pattern to a RegExp source string. Supports `*`, `**`, `?`,
 * `[...]` character classes, and `{a,b}` alternation.
 */
function globSource(glob: string): string {
  let out = "";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 3;
        } else {
          out += ".*";
          i += 2;
        }
      } else {
        out += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      out += "[^/]";
      i += 1;
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) {
        out += "\\[";
        i += 1;
      } else {
        let cls = glob.slice(i + 1, end);
        if (cls.startsWith("!")) cls = "^" + cls.slice(1);
        out += `[${cls}]`;
        i = end + 1;
      }
    } else if (c === "{") {
      const end = glob.indexOf("}", i + 1);
      if (end === -1) {
        out += "\\{";
        i += 1;
      } else {
        const parts = glob.slice(i + 1, end).split(",");
        out += `(?:${parts.map(globSource).join("|")})`;
        i = end + 1;
      }
    } else {
      out += c.replace(/[.+^$()|\\\]}]/g, "\\$&");
      i += 1;
    }
  }
  return out;
}

/**
 * Match a slash-separated relative path against a glob pattern. Patterns
 * without a slash match against the basename (gitignore convention).
 */
function matchesGlob(relPath: string, pattern: string): boolean {
  const subject = pattern.includes("/") ? relPath : path.posix.basename(relPath);
  return new RegExp(`^${globSource(pattern)}$`).test(subject);
}

/** Recursively yield files under `dir`, skipping VCS/deps dirs and symlinks. */
async function* walkFiles(dir: string): AsyncGenerator<string> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SEARCH_SKIP_DIRS.has(entry.name)) continue;
      yield* walkFiles(abs);
    } else if (entry.isFile()) {
      yield abs;
    }
    // Symlinks (and other special entries) are intentionally skipped: they
    // could point outside the sandbox.
  }
}

/** Heuristic binary check: NUL byte in the first 8 KiB. */
async function isBinaryFile(filePath: string): Promise<boolean> {
  const handle = await fs.open(filePath, "r");
  try {
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

/** Run ripgrep and collect up to `limit` raw matches. */
async function grepWithRipgrep(
  rgPath: string,
  searchRoot: string,
  pattern: string,
  opts: { caseInsensitive: boolean; glob?: string },
  limit: number
): Promise<{ raw: RawGrepMatch[]; truncated: boolean }> {
  const { spawn } = await import("node:child_process");
  const rgArgs = [
    "--json",
    "--no-ignore",
    "--hidden",
    "--no-messages",
    "--glob",
    "!**/.git/**",
    "--glob",
    "!**/node_modules/**",
  ];
  if (opts.caseInsensitive) rgArgs.push("--ignore-case");
  if (opts.glob) rgArgs.push("--glob", opts.glob);
  rgArgs.push("--regexp", pattern, "--", searchRoot);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(rgPath, rgArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const raw: RawGrepMatch[] = [];
    let truncated = false;
    let stderr = "";
    let buffered = "";
    let settled = false;

    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) rejectPromise(err);
      else resolvePromise({ raw, truncated });
    };

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.stdout.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let newline: number;
      while ((newline = buffered.indexOf("\n")) !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (!line.trim()) continue;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type !== "match") continue;
        const file = event.data?.path?.text;
        const text = event.data?.lines?.text;
        const lineNumber = event.data?.line_number;
        // Skip non-UTF8 payloads (rg reports them as base64 `bytes`).
        if (typeof file !== "string" || typeof text !== "string") continue;
        if (typeof lineNumber !== "number") continue;
        if (raw.length >= limit) {
          truncated = true;
          child.kill();
          finish();
          return;
        }
        raw.push({ file, lineNumber, line: text.replace(/\r?\n$/, "") });
      }
    });
    child.on("error", (err) => finish(err));
    child.on("close", (code) => {
      // rg exits 0 on matches, 1 on no matches, 2 on error.
      if (!truncated && code !== null && code > 1) {
        finish(new Error(`ripgrep failed: ${stderr.trim() || `exit code ${code}`}`));
        return;
      }
      finish();
    });
  });
}

/** Pure-JS streaming grep fallback (no ripgrep on PATH). */
async function grepWithJs(
  searchRoot: string,
  regex: RegExp,
  globFilter: string | undefined,
  limit: number
): Promise<{ raw: RawGrepMatch[]; truncated: boolean }> {
  const { createInterface } = await import("node:readline");
  const raw: RawGrepMatch[] = [];
  let truncated = false;

  const rootStat = await fs.stat(searchRoot);
  const files = rootStat.isFile() ? singleton(searchRoot) : walkFiles(searchRoot);

  outer: for await (const file of files) {
    if (globFilter) {
      const rel =
        searchRoot === file
          ? path.basename(file)
          : path.relative(searchRoot, file).split(path.sep).join("/");
      if (!matchesGlob(rel, globFilter)) continue;
    }
    try {
      if (await isBinaryFile(file)) continue;
    } catch {
      continue;
    }
    const stream = fsSync.createReadStream(file, { encoding: "utf8" });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });
    let lineNumber = 0;
    try {
      for await (const line of rl) {
        lineNumber += 1;
        if (!regex.test(line)) continue;
        if (raw.length >= limit) {
          truncated = true;
          break outer;
        }
        raw.push({ file, lineNumber, line });
      }
    } catch {
      // Unreadable file mid-stream: skip the rest of it.
    } finally {
      rl.close();
      stream.destroy();
    }
  }
  return { raw, truncated };
}

async function* singleton<T>(value: T): AsyncGenerator<T> {
  yield value;
}

// ---------------------------------------------------------------------------
// FsService class
// ---------------------------------------------------------------------------

export class FsService {
  private readonly contextFolderManager: ContextFolderManager;
  private readonly entityCache: EntityCache;
  /** Extensions granted explicit unrestricted host-fs access (Phase 3 capability). */
  private readonly hostFsCapableExtensions?: ReadonlySet<string>;
  /** Routes GAD-tracked context mutations through GAD instead of raw disk. */
  private readonly vcsBridge?: FsVcsBridge;

  /** handleId → TrackedHandle */
  private readonly openHandles = new Map<number, TrackedHandle>();
  private nextHandleId = 1;

  constructor(
    contextFolderManager: ContextFolderManager,
    entityCache: EntityCache = new EntityCache(),
    opts?: { hostFsCapableExtensions?: Iterable<string>; vcsBridge?: FsVcsBridge }
  ) {
    this.contextFolderManager = contextFolderManager;
    this.entityCache = entityCache;
    this.hostFsCapableExtensions = opts?.hostFsCapableExtensions
      ? new Set(opts.hostFsCapableExtensions)
      : undefined;
    this.vcsBridge = opts?.vcsBridge;
  }

  // =========================================================================
  // FileHandle cleanup
  // =========================================================================

  /** Close all open file handles for a given caller. */
  closeHandlesForCaller(callerId: string): void {
    this._closeHandlesImpl(callerId);
  }

  private _closeHandlesImpl(callerId: string): void {
    for (const [id, tracked] of this.openHandles) {
      if (tracked.panelId === callerId) {
        clearTimeout(tracked.timer);
        tracked.handle.close().catch(() => {});
        this.openHandles.delete(id);
      }
    }
  }

  // =========================================================================
  // Context resolution
  // =========================================================================

  /**
   * Resolve the context root path for a service call.
   * - panel/app/worker/DO callers: look up contextId from EntityCache
   * - extension callers inside an invocation: use the chained caller context
   * - extension callers outside an invocation: unrestricted host fs
   * - server/shell/harness callers: contextId is the first arg (shifted from
   *   the args array). Shell and harness callers must name an existing
   *   context; server callers may create one on the fly.
   */
  private async resolveContextRoot(ctx: ServiceContext, args: unknown[]): Promise<FsCallScope> {
    let contextId: string;
    let panelId: string;

    if (
      ctx.caller.runtime.kind === "panel" ||
      ctx.caller.runtime.kind === "app" ||
      ctx.caller.runtime.kind === "worker" ||
      ctx.caller.runtime.kind === "do"
    ) {
      panelId = ctx.caller.runtime.id;
      const cid = this.entityCache.resolveContext(panelId);
      if (!cid) {
        throw new Error(`No context registered for ${ctx.caller.runtime.kind} ${panelId}`);
      }
      contextId = cid;
    } else if (ctx.caller.runtime.kind === "extension") {
      if (ctx.chainCaller) {
        panelId = `extension:${ctx.caller.runtime.id}:chain:${ctx.chainCaller.callerId}`;
        const cid = this.entityCache.resolveContext(ctx.chainCaller.callerId);
        if (!cid) {
          throw new Error(
            `No context registered for ${ctx.chainCaller.callerKind} ${ctx.chainCaller.callerId}`
          );
        }
        contextId = cid;
        const state = this.contextFolderManager.getContextFolderState(contextId);
        if (state.status !== "ready") {
          throw codedError(
            "ENOTREADY",
            `Context folder ${contextId} is ${state.status}; scoped extension filesystem calls must wait for context materialization`
          );
        }
        const root = await this.contextFolderManager.ensureContextFolder(contextId);
        return {
          root,
          panelId,
          contextId,
          unrestricted: false,
          exposeHostPaths: true,
        };
      }
      // Phase 3: an extension acting on its own behalf (no chainCaller) used to
      // SILENTLY get unrestricted host filesystem access — conflating two trust
      // models and escalating privilege without any signal. Host-fs authority is
      // now an explicit, named capability an extension must hold; otherwise the
      // call fails loud rather than reading `/`.
      if (this.extensionHasHostFsCapability(ctx.caller.runtime.id)) {
        return {
          root: "",
          panelId: `extension:${ctx.caller.runtime.id}`,
          unrestricted: true,
          exposeHostPaths: true,
        };
      }
      throw new Error(
        `Extension ${ctx.caller.runtime.id} attempted a filesystem call outside an ` +
          `on-behalf-of context and without the host-fs-access capability`
      );
    } else {
      // Server / shell / harness callers pass an explicit contextId as the
      // first argument.
      const kind = ctx.caller.runtime.kind;
      contextId = args.shift() as string;
      panelId = `${kind}:${ctx.caller.runtime.id}`;
      if (!contextId || typeof contextId !== "string") {
        throw new Error(`${kind} fs calls must provide contextId as first argument`);
      }
      if (kind !== "server") {
        // Shell / harness callers may only address contexts that already
        // exist (a context folder on disk, or an active entity bound to the
        // context). Server callers are trusted to create contexts.
        const known =
          this.contextFolderManager.getContextRoot(contextId) !== null ||
          this.entityCache.listActive().some((record) => record.contextId === contextId);
        if (!known) {
          throw new Error(`Unknown contextId: ${contextId}`);
        }
      }
    }

    const root = await this.contextFolderManager.ensureContextFolder(contextId);
    return {
      root,
      panelId,
      contextId,
      unrestricted: false,
      exposeHostPaths: false,
    };
  }

  /**
   * Whether an extension holds the explicit `host-fs-access` capability that
   * grants unrestricted host filesystem access when acting on its own behalf
   * (no on-behalf-of context). This is a *distinct* grant from native-code
   * install approval — being native does not imply host-fs authority. The
   * allowlist is injected via deps (`hostFsCapableExtensions`); empty by default,
   * so the privileged path is opt-in rather than a silent fallback.
   */
  private extensionHasHostFsCapability(extensionId: string): boolean {
    return this.hostFsCapableExtensions?.has(extensionId) ?? false;
  }

  // =========================================================================
  // FileHandle helpers
  // =========================================================================

  private trackHandle(handle: NodeFileHandle, panelId: string): number {
    const id = this.nextHandleId++;
    const timer = setTimeout(() => {
      log.info(`Closing idle file handle ${id} for ${panelId}`);
      handle.close().catch(() => {});
      this.openHandles.delete(id);
    }, HANDLE_IDLE_TIMEOUT_MS);
    this.openHandles.set(id, { handle, panelId, timer });
    return id;
  }

  private getTrackedHandle(handleId: number, callerPanelId: string): TrackedHandle {
    const tracked = this.openHandles.get(handleId);
    if (!tracked) throw new Error(`Invalid file handle: ${handleId}`);
    if (tracked.panelId !== callerPanelId) {
      throw new Error(`File handle ${handleId} does not belong to caller`);
    }
    // Reset idle timer
    clearTimeout(tracked.timer);
    tracked.timer = setTimeout(() => {
      tracked.handle.close().catch(() => {});
      this.openHandles.delete(handleId);
    }, HANDLE_IDLE_TIMEOUT_MS);
    return tracked;
  }

  // =========================================================================
  // GAD reroute
  // =========================================================================

  /**
   * Intercept mutating fs calls from a sandboxed context caller whose target is
   * a GAD-tracked path, and commit them through GAD instead of writing the
   * worktree projection directly. Returns `{ handled: false }` for reads,
   * scratch/ignored paths, host-fs/unrestricted callers, or when no vcs bridge
   * is wired — those fall through to the direct-disk implementation.
   */
  private async maybeRouteToGad(
    scope: FsCallScope,
    ctx: ServiceContext,
    method: string,
    args: unknown[]
  ): Promise<{ handled: boolean; result?: unknown }> {
    const bridge = this.vcsBridge;
    if (!bridge || scope.unrestricted || !scope.contextId) return { handled: false };
    const contextId = scope.contextId;
    const actor = { id: ctx.caller.runtime.id, kind: ctx.caller.runtime.kind };
    const relOf = async (userPath: string): Promise<string> => {
      const abs = await resolveFsPath(scope, userPath);
      return path.relative(scope.root, abs).split(path.sep).join("/");
    };
    const tracked = (rel: string) => bridge.isTracked(rel);
    const commit = (edits: FsVcsEditOp[]) =>
      edits.length > 0 ? bridge.applyEdits(contextId, edits, actor) : Promise.resolve();

    switch (method) {
      case "writeFile": {
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        await commit([{ kind: "write", path: rel, content: dataToVcsContent(args[1]) }]);
        return { handled: true };
      }
      case "appendFile": {
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        const content = appendVcsContent(await bridge.readFile(contextId, rel), args[1]);
        await commit([{ kind: "write", path: rel, content }]);
        return { handled: true };
      }
      case "truncate": {
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        const content = truncateVcsContent(
          await bridge.readFile(contextId, rel),
          (args[1] as number | undefined) ?? 0
        );
        await commit([{ kind: "write", path: rel, content }]);
        return { handled: true };
      }
      case "chmod": {
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        await commit([{ kind: "chmod", path: rel, mode: args[1] as number }]);
        return { handled: true };
      }
      case "unlink": {
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        await commit([{ kind: "delete", path: rel }]);
        return { handled: true };
      }
      case "rmdir": {
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        await commit(await this.subtreeDeleteEdits(bridge, contextId, rel));
        return { handled: true };
      }
      case "rm": {
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        const recursive = !!(args[1] as { recursive?: boolean } | undefined)?.recursive;
        await commit(
          recursive
            ? await this.subtreeDeleteEdits(bridge, contextId, rel)
            : [{ kind: "delete", path: rel }]
        );
        return { handled: true };
      }
      case "copyFile": {
        const dstRel = await relOf(args[1] as string);
        if (!(await tracked(dstRel))) return { handled: false };
        const srcRel = await relOf(args[0] as string);
        const content = (await tracked(srcRel))
          ? await bridge.readFile(contextId, srcRel)
          : dataToVcsContent(encodeBinary(await fs.readFile(await resolveFsPath(scope, args[0] as string))));
        if (!content) throw codedError("ENOENT", `copyFile: source not found: ${String(args[0])}`);
        await commit([{ kind: "write", path: dstRel, content }]);
        return { handled: true };
      }
      case "rename": {
        const srcRel = await relOf(args[0] as string);
        const dstRel = await relOf(args[1] as string);
        const srcTracked = await tracked(srcRel);
        const dstTracked = await tracked(dstRel);
        if (!srcTracked && !dstTracked) return { handled: false };
        if (srcTracked && dstTracked) {
          await commit(await this.renameEdits(bridge, contextId, srcRel, dstRel));
          return { handled: true };
        }
        if (!srcTracked && dstTracked) {
          // Atomic-write pattern: a scratch temp file renamed into a tracked
          // path. Commit its bytes through GAD, then drop the temp file.
          const srcAbs = await resolveFsPath(scope, args[0] as string);
          const buf = await fs.readFile(srcAbs);
          await commit([
            { kind: "write", path: dstRel, content: dataToVcsContent(encodeBinary(buf)) },
          ]);
          await fs.rm(srcAbs, { force: true });
          return { handled: true };
        }
        // tracked → scratch: moving source out of the GAD tree.
        throw new Error(
          `fs.rename of the GAD-tracked path ${JSON.stringify(args[0])} to a scratch path is not ` +
            `supported. Source mutations must go through GAD (vcs.applyEdits / the write tool).`
        );
      }
      case "open": {
        const flags = (args[1] as string | undefined) ?? "r";
        if (!/[wax+]/.test(flags)) return { handled: false };
        const rel = await relOf(args[0] as string);
        if (!(await tracked(rel))) return { handled: false };
        throw new Error(
          `fs.open with write flags is not supported on the GAD-tracked path ${JSON.stringify(args[0])}. ` +
            `Source edits must commit through GAD — use the write/edit tool or vcs.applyEdits.`
        );
      }
      default:
        // reads, mkdir, utimes, mktemp, handle* → direct disk
        return { handled: false };
    }
  }

  /** Delete ops for a path and (if it is a directory) its whole tracked subtree. */
  private async subtreeDeleteEdits(
    bridge: FsVcsBridge,
    contextId: string,
    rel: string
  ): Promise<FsVcsEditOp[]> {
    const prefix = `${rel}/`;
    const files = await bridge.listFiles(contextId);
    return files
      .filter((p) => p === rel || p.startsWith(prefix))
      .map((p) => ({ kind: "delete" as const, path: p }));
  }

  /** Move a tracked file (or directory subtree) from `srcRel` to `dstRel`. */
  private async renameEdits(
    bridge: FsVcsBridge,
    contextId: string,
    srcRel: string,
    dstRel: string
  ): Promise<FsVcsEditOp[]> {
    const prefix = `${srcRel}/`;
    const files = (await bridge.listFiles(contextId)).filter(
      (p) => p === srcRel || p.startsWith(prefix)
    );
    const edits: FsVcsEditOp[] = [];
    for (const oldPath of files) {
      const content = await bridge.readFile(contextId, oldPath);
      if (!content) continue;
      const newPath = oldPath === srcRel ? dstRel : `${dstRel}/${oldPath.slice(prefix.length)}`;
      edits.push({ kind: "write", path: newPath, content });
      edits.push({ kind: "delete", path: oldPath });
    }
    return edits;
  }

  // =========================================================================
  // Main dispatch handler
  // =========================================================================

  async handleCall(ctx: ServiceContext, method: string, rawArgs: unknown[]): Promise<unknown> {
    // Clone args so shift() in resolveContextRoot doesn't mutate the original
    const args = [...rawArgs];
    const scope = await this.resolveContextRoot(ctx, args);
    const { panelId } = scope;

    // Sandboxed context mutations to GAD-tracked paths commit through GAD
    // (edit-first) rather than writing the worktree projection directly.
    const routed = await this.maybeRouteToGad(scope, ctx, method, args);
    if (routed.handled) return routed.result;

    switch (method) {
      // ----- File content -----
      case "readFile": {
        const p = await resolveFsPath(scope, args[0] as string);
        const encoding = args[1] as string | undefined;
        if (encoding) {
          return fs.readFile(p, encoding as BufferEncoding);
        }
        const buf = await fs.readFile(p);
        return encodeBinary(buf);
      }

      case "writeFile": {
        const resolvedPath = await resolveFsPathInfo(scope, args[0] as string);
        const p = resolvedPath.path;
        const data = isBinaryEnvelope(args[1]) ? decodeBinary(args[1]) : (args[1] as string);
        await fs.writeFile(p, data);
        return;
      }

      case "appendFile": {
        const p = await resolveFsPath(scope, args[0] as string);
        const data = isBinaryEnvelope(args[1]) ? decodeBinary(args[1]) : (args[1] as string);
        await fs.appendFile(p, data);
        return;
      }

      // ----- Directory operations -----
      case "readdir": {
        const p = await resolveFsPath(scope, args[0] as string);
        const opts = args[1] as { withFileTypes?: boolean; recursive?: boolean } | undefined;
        const recursive = opts?.recursive ?? false;
        if (opts?.withFileTypes) {
          const entries = await fs.readdir(p, { withFileTypes: true, recursive });
          // For recursive listings, report names relative to the listed
          // directory (Node's Dirent.name is just the basename).
          return entries.map((d) =>
            serializeDirent(d, recursive ? relativeDirentName(p, d) : d.name)
          );
        }
        return fs.readdir(p, recursive ? { recursive } : undefined);
      }

      case "grep": {
        return this.grep(scope, args[0] as string, args[1] as GrepOptions | undefined);
      }

      case "glob": {
        return this.glob(scope, args[0] as string, args[1] as GlobOptions | undefined);
      }

      case "mkdir": {
        const resolvedPath = await resolveFsPathInfo(scope, args[0] as string);
        const p = resolvedPath.path;
        const opts = args[1] as { recursive?: boolean } | undefined;
        const result = await fs.mkdir(p, opts);
        // Return first-created path relative to context root (Node API contract)
        return result && !scope.unrestricted ? "/" + path.relative(scope.root, result) : result;
      }

      case "rmdir": {
        const p = await resolveFsPath(scope, args[0] as string);
        await fs.rmdir(p);
        return;
      }

      case "rm": {
        const p = await resolveFsPath(scope, args[0] as string);
        const opts = args[1] as { recursive?: boolean; force?: boolean } | undefined;
        await fs.rm(p, opts);
        return;
      }

      // ----- Stat / metadata -----
      case "stat": {
        const p = await resolveFsPath(scope, args[0] as string);
        return serializeStat(await fs.stat(p));
      }

      case "lstat": {
        const p = await resolveFsPath(scope, args[0] as string);
        return serializeStat(await fs.lstat(p));
      }

      case "exists": {
        const p = await resolveFsPath(scope, args[0] as string);
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      }

      case "access": {
        const p = await resolveFsPath(scope, args[0] as string);
        await fs.access(p, args[1] as number | undefined);
        return;
      }

      // ----- File manipulation -----
      case "unlink": {
        const p = await resolveFsPath(scope, args[0] as string);
        await fs.unlink(p);
        return;
      }

      case "copyFile": {
        const src = await resolveFsPath(scope, args[0] as string);
        const dest = await resolveFsPath(scope, args[1] as string);
        await fs.copyFile(src, dest);
        return;
      }

      case "rename": {
        const oldP = await resolveFsPath(scope, args[0] as string);
        const newP = await resolveFsPath(scope, args[1] as string);
        await fs.rename(oldP, newP);
        return;
      }

      case "realpath": {
        const p = await resolveFsPath(scope, args[0] as string);
        const real = await fs.realpath(p);
        if (scope.unrestricted || scope.exposeHostPaths) return real;
        // Return relative to root (panel sees paths relative to context root)
        if (!real.startsWith(scope.root + path.sep) && real !== scope.root) {
          throw new Error("Realpath escapes sandbox");
        }
        return "/" + path.relative(scope.root, real);
      }

      case "truncate": {
        const p = await resolveFsPath(scope, args[0] as string);
        await fs.truncate(p, args[1] as number | undefined);
        return;
      }

      // ----- Symlinks -----
      case "readlink": {
        const p = await resolveFsPath(scope, args[0] as string);
        const target = await fs.readlink(p);
        if (scope.unrestricted) return target;
        // If the target is absolute, relativize to prevent leaking host paths
        if (path.isAbsolute(target)) {
          const resolved = path.resolve(path.dirname(p), target);
          if (!resolved.startsWith(scope.root + path.sep) && resolved !== scope.root) {
            throw new Error("Readlink target escapes sandbox");
          }
          return "/" + path.relative(scope.root, resolved);
        }
        return target;
      }

      // NOTE: `symlink` and `chown` were removed entirely (audit findings #38,
      // #39): they are sandbox-escape primitives (TOCTOU symlink races,
      // privilege weirdness on setgid dirs). Internal server code can use raw
      // Node fs; nothing in the service surface needs them.

      // ----- Permissions & timestamps -----
      case "chmod": {
        const p = await resolveFsPath(scope, args[0] as string);
        await fs.chmod(p, args[1] as number);
        return;
      }

      case "utimes": {
        const p = await resolveFsPath(scope, args[0] as string);
        await fs.utimes(p, args[1] as number, args[2] as number);
        return;
      }

      // ----- File handles -----
      case "open": {
        const p = await resolveFsPath(scope, args[0] as string);
        const flags = (args[1] as string) ?? "r";
        const mode = args[2] as number | undefined;
        const handle = await fs.open(p, flags, mode);
        const handleId = this.trackHandle(handle, panelId);
        return { handleId };
      }

      case "handleRead": {
        const tracked = this.getTrackedHandle(args[0] as number, panelId);
        const length = args[1] as number;
        if (length < 0) {
          throw new Error(`Read length out of range`);
        }
        const position = args[2] as number | null;
        const buf = Buffer.alloc(length);
        const result = await tracked.handle.read(buf, 0, length, position);
        return {
          bytesRead: result.bytesRead,
          buffer: encodeBinary(buf.subarray(0, result.bytesRead)),
        };
      }

      case "handleWrite": {
        const tracked = this.getTrackedHandle(args[0] as number, panelId);
        const data = isBinaryEnvelope(args[1])
          ? decodeBinary(args[1])
          : Buffer.from(args[1] as string);
        const position = (args[2] as number | null) ?? null;
        const result = await tracked.handle.write(data, 0, data.length, position);
        return { bytesWritten: result.bytesWritten };
      }

      case "handleClose": {
        const id = args[0] as number;
        const tracked = this.openHandles.get(id);
        if (tracked) {
          if (tracked.panelId !== panelId) {
            throw new Error(`File handle ${id} does not belong to caller`);
          }
          clearTimeout(tracked.timer);
          await tracked.handle.close();
          this.openHandles.delete(id);
        }
        return;
      }

      case "handleStat": {
        const tracked = this.getTrackedHandle(args[0] as number, panelId);
        return serializeStat(await tracked.handle.stat());
      }

      // ----- Tmp files (atomic-write helper for tools) -----
      case "mktemp": {
        const prefix = args[0];
        if (prefix !== undefined && typeof prefix !== "string") {
          throw new Error("mktemp prefix must be a string when provided");
        }
        // Normalize prefix: strip any path separators so callers can't escape
        // `.tmp/` by passing e.g. "../foo". Audit finding #20 (filesystem
        // report): strip leading dots so callers cannot create .htaccess /
        // .DS_Store / other hidden-file conventions inside `.tmp/`.
        let safePrefix = (prefix ?? "tmp").replace(/[\\/]/g, "_").replace(/^\.+/, "");
        if (safePrefix.length === 0) safePrefix = "tmp";
        const tmpDir = path.join(scope.root, ".tmp");
        await fs.mkdir(tmpDir, { recursive: true });
        // Audit finding #34: 16 bytes of crypto-grade entropy in the suffix
        // (was already crypto.randomBytes(8); widened to 16 to reduce
        // brute-force pre-create races).
        const random = randomBytes(16).toString("hex");
        const filename = `${safePrefix}-${random}`;
        // Return path relative to context root (with leading `/`) so it
        // matches the format other fs methods accept.
        return "/" + path.posix.join(".tmp", filename);
      }

      default:
        throw new Error(`Unknown fs method: ${method}`);
    }
  }

  // =========================================================================
  // Search (grep / glob)
  // =========================================================================

  /** Map an absolute path back to the caller-visible form. */
  private toDisplayPath(scope: FsCallScope, absolutePath: string): string {
    if (scope.unrestricted) return absolutePath;
    if (absolutePath === scope.root) return "/";
    return "/" + path.relative(scope.root, absolutePath).split(path.sep).join("/");
  }

  /**
   * Search file contents under the context root. Uses a ripgrep subprocess
   * when `rg` is on PATH, with a streaming pure-JS fallback. Skips `.git`,
   * `node_modules`, symlinks, and binary files.
   */
  private async grep(
    scope: FsCallScope,
    pattern: string,
    opts: GrepOptions = {}
  ): Promise<GrepResult> {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error("grep pattern must be a non-empty string");
    }
    const caseInsensitive = opts.caseInsensitive ?? false;
    // Validate the pattern eagerly (also used by the JS fallback and shared
    // with ripgrep's regex dialect for everyday patterns).
    const regex = new RegExp(pattern, caseInsensitive ? "i" : "");
    const contextLines = Math.min(
      GREP_MAX_CONTEXT_LINES,
      Math.max(0, Math.floor(opts.contextLines ?? 0))
    );
    const maxMatches = Math.min(
      GREP_HARD_MAX_MATCHES,
      Math.max(1, Math.floor(opts.maxMatches ?? GREP_DEFAULT_MAX_MATCHES))
    );
    const searchRoot = await resolveFsPath(scope, opts.path ?? "/");

    const rgPath = findRipgrep();
    const { raw, truncated } = rgPath
      ? await grepWithRipgrep(
          rgPath,
          searchRoot,
          pattern,
          { caseInsensitive, glob: opts.glob },
          maxMatches
        )
      : await grepWithJs(searchRoot, regex, opts.glob, maxMatches);

    // Attach context lines by re-reading matched files (bounded by maxMatches).
    const fileLines = new Map<string, string[]>();
    if (contextLines > 0) {
      for (const file of new Set(raw.map((m) => m.file))) {
        try {
          fileLines.set(file, (await fs.readFile(file, "utf8")).split(/\r?\n/));
        } catch {
          // File vanished between search and context read; emit without context.
        }
      }
    }

    const matches: GrepMatch[] = raw.map((m) => {
      const lines = fileLines.get(m.file);
      const idx = m.lineNumber - 1;
      return {
        file: this.toDisplayPath(scope, m.file),
        lineNumber: m.lineNumber,
        line: m.line,
        before: lines ? lines.slice(Math.max(0, idx - contextLines), idx) : [],
        after: lines ? lines.slice(idx + 1, idx + 1 + contextLines) : [],
      };
    });

    return { matches, matchCount: matches.length, truncated };
  }

  /**
   * Find files matching a glob pattern under the context root, sorted by
   * mtime descending. Skips `.git`, `node_modules`, and symlinks.
   */
  private async glob(
    scope: FsCallScope,
    pattern: string,
    opts: GlobOptions = {}
  ): Promise<string[]> {
    if (typeof pattern !== "string" || pattern.length === 0) {
      throw new Error("glob pattern must be a non-empty string");
    }
    const searchRoot = await resolveFsPath(scope, opts.path ?? "/");
    const matched: Array<{ file: string; mtimeMs: number }> = [];
    for await (const file of walkFiles(searchRoot)) {
      const rel = path.relative(searchRoot, file).split(path.sep).join("/");
      if (!matchesGlob(rel, pattern)) continue;
      try {
        matched.push({ file, mtimeMs: (await fs.lstat(file)).mtimeMs });
      } catch {
        // File vanished mid-walk.
      }
    }
    matched.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return matched.map((m) => this.toDisplayPath(scope, m.file));
  }
}

// ---------------------------------------------------------------------------
// Convenience: top-level handler for dispatcher.register("fs", ...)
// ---------------------------------------------------------------------------

export function handleFsCall(
  fsService: FsService,
  ctx: ServiceContext,
  method: string,
  args: unknown[]
): Promise<unknown> {
  return fsService.handleCall(ctx, method, args);
}
