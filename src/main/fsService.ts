/**
 * fsService — Server-side filesystem handler for panel RPC calls.
 *
 * Registered in the Electron main process dispatcher (not SERVER_SERVICES),
 * so panel fs.* calls route through Electron IPC where PanelManager context
 * is available. In headless mode, registered in the server process dispatcher.
 *
 * All operations are sandboxed to the caller's context folder via path
 * validation and symlink traversal checks.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import type { FileHandle as NodeFileHandle } from "fs/promises";
import type { ServiceContext } from "./serviceDispatcher.js";
import type { ContextFolderManager } from "./contextFolderManager.js";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("FsService");

/** Idle timeout for open file handles (5 minutes). */
const HANDLE_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum bytes for a single handleRead call (64 MB). */
const MAX_READ_LENGTH = 64 * 1024 * 1024;

/** Tracked file handle with cleanup metadata. */
interface TrackedHandle {
  handle: NodeFileHandle;
  panelId: string;
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Path sandboxing
// ---------------------------------------------------------------------------

/**
 * Resolve a user-provided path within a sandbox root, preventing traversal
 * and symlink-based escapes.
 */
async function sandboxPath(root: string, userPath: string): Promise<string> {
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
  return resolved;
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
// Stat serialisation
// ---------------------------------------------------------------------------

function serializeStat(stats: fsSync.Stats) {
  return {
    isFile: stats.isFile(),
    isDirectory: stats.isDirectory(),
    size: stats.size,
    mtime: stats.mtime.toISOString(),
    ctime: stats.ctime.toISOString(),
    mode: stats.mode,
  };
}

function serializeDirent(d: fsSync.Dirent) {
  return {
    name: d.name,
    _isFile: d.isFile(),
    _isDirectory: d.isDirectory(),
    _isSymbolicLink: d.isSymbolicLink(),
  };
}

// ---------------------------------------------------------------------------
// FsService class
// ---------------------------------------------------------------------------

export class FsService {
  private readonly contextFolderManager: ContextFolderManager;

  /** panelId → contextId mapping */
  private readonly panelContextMap = new Map<string, string>();

  /** handleId → TrackedHandle */
  private readonly openHandles = new Map<number, TrackedHandle>();
  private nextHandleId = 1;

  constructor(contextFolderManager: ContextFolderManager) {
    this.contextFolderManager = contextFolderManager;
  }

  // =========================================================================
  // Panel context registration
  // =========================================================================

  registerPanelContext(panelId: string, contextId: string): void {
    this.panelContextMap.set(panelId, contextId);
  }

  unregisterPanelContext(panelId: string): void {
    this.panelContextMap.delete(panelId);
  }

  // =========================================================================
  // FileHandle cleanup
  // =========================================================================

  /** Close all open file handles for a given panel. */
  closeHandlesForPanel(panelId: string): void {
    for (const [id, tracked] of this.openHandles) {
      if (tracked.panelId === panelId) {
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
   * - panel callers: look up contextId from panelContextMap
   * - server callers: contextId is the first arg (shifted from args array)
   */
  private async resolveContextRoot(
    ctx: ServiceContext,
    args: unknown[],
  ): Promise<{ root: string; panelId: string }> {
    let contextId: string;
    let panelId: string;

    if (ctx.callerKind === "panel") {
      panelId = ctx.callerId;
      const cid = this.panelContextMap.get(panelId);
      if (!cid) {
        throw new Error(`No context registered for panel ${panelId}`);
      }
      contextId = cid;
    } else {
      // Server-originated calls pass contextId as first arg
      contextId = args.shift() as string;
      panelId = `server:${ctx.callerId}`;
      if (!contextId || typeof contextId !== "string") {
        throw new Error("Server fs calls must provide contextId as first argument");
      }
    }

    const root = await this.contextFolderManager.ensureContextFolder(contextId);
    return { root, panelId };
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
  // Main dispatch handler
  // =========================================================================

  async handleCall(
    ctx: ServiceContext,
    method: string,
    rawArgs: unknown[],
  ): Promise<unknown> {
    // Clone args so shift() in resolveContextRoot doesn't mutate the original
    const args = [...rawArgs];
    const { root, panelId } = await this.resolveContextRoot(ctx, args);

    switch (method) {
      // ----- File content -----
      case "readFile": {
        const p = await sandboxPath(root, args[0] as string);
        const encoding = args[1] as string | undefined;
        if (encoding) {
          return fs.readFile(p, encoding as BufferEncoding);
        }
        const buf = await fs.readFile(p);
        return encodeBinary(buf);
      }

      case "writeFile": {
        const p = await sandboxPath(root, args[0] as string);
        const data = isBinaryEnvelope(args[1])
          ? decodeBinary(args[1])
          : (args[1] as string);
        await fs.writeFile(p, data);
        return;
      }

      case "appendFile": {
        const p = await sandboxPath(root, args[0] as string);
        const data = isBinaryEnvelope(args[1])
          ? decodeBinary(args[1])
          : (args[1] as string);
        await fs.appendFile(p, data);
        return;
      }

      // ----- Directory operations -----
      case "readdir": {
        const p = await sandboxPath(root, args[0] as string);
        const opts = args[1] as { withFileTypes?: boolean } | undefined;
        if (opts?.withFileTypes) {
          const entries = await fs.readdir(p, { withFileTypes: true });
          return entries.map(serializeDirent);
        }
        return fs.readdir(p);
      }

      case "mkdir": {
        const p = await sandboxPath(root, args[0] as string);
        const opts = args[1] as { recursive?: boolean } | undefined;
        const result = await fs.mkdir(p, opts);
        // Return first-created path relative to context root (Node API contract)
        return result ? "/" + path.relative(root, result) : undefined;
      }

      case "rmdir": {
        const p = await sandboxPath(root, args[0] as string);
        await fs.rmdir(p);
        return;
      }

      case "rm": {
        const p = await sandboxPath(root, args[0] as string);
        const opts = args[1] as { recursive?: boolean; force?: boolean } | undefined;
        await fs.rm(p, opts);
        return;
      }

      // ----- Stat / metadata -----
      case "stat": {
        const p = await sandboxPath(root, args[0] as string);
        return serializeStat(await fs.stat(p));
      }

      case "lstat": {
        const p = await sandboxPath(root, args[0] as string);
        return serializeStat(await fs.lstat(p));
      }

      case "exists": {
        const p = await sandboxPath(root, args[0] as string);
        try {
          await fs.access(p);
          return true;
        } catch {
          return false;
        }
      }

      case "access": {
        const p = await sandboxPath(root, args[0] as string);
        await fs.access(p, args[1] as number | undefined);
        return;
      }

      // ----- File manipulation -----
      case "unlink": {
        const p = await sandboxPath(root, args[0] as string);
        await fs.unlink(p);
        return;
      }

      case "copyFile": {
        const src = await sandboxPath(root, args[0] as string);
        const dest = await sandboxPath(root, args[1] as string);
        await fs.copyFile(src, dest);
        return;
      }

      case "rename": {
        const oldP = await sandboxPath(root, args[0] as string);
        const newP = await sandboxPath(root, args[1] as string);
        await fs.rename(oldP, newP);
        return;
      }

      case "realpath": {
        const p = await sandboxPath(root, args[0] as string);
        const real = await fs.realpath(p);
        // Return relative to root (panel sees paths relative to context root)
        if (!real.startsWith(root + path.sep) && real !== root) {
          throw new Error("Realpath escapes sandbox");
        }
        return "/" + path.relative(root, real);
      }

      case "truncate": {
        const p = await sandboxPath(root, args[0] as string);
        await fs.truncate(p, args[1] as number | undefined);
        return;
      }

      // ----- Symlinks -----
      case "readlink": {
        const p = await sandboxPath(root, args[0] as string);
        const target = await fs.readlink(p);
        // If the target is absolute, relativize to prevent leaking host paths
        if (path.isAbsolute(target)) {
          const resolved = path.resolve(path.dirname(p), target);
          if (!resolved.startsWith(root + path.sep) && resolved !== root) {
            throw new Error("Readlink target escapes sandbox");
          }
          return "/" + path.relative(root, resolved);
        }
        return target;
      }

      case "symlink": {
        // Validate that the target resolves within the context root
        const target = args[0] as string;
        const linkPath = await sandboxPath(root, args[1] as string);
        // Resolve the target relative to the link's parent directory
        const linkDir = path.dirname(linkPath);
        const resolvedTarget = path.resolve(linkDir, target);
        if (
          !resolvedTarget.startsWith(root + path.sep) &&
          resolvedTarget !== root
        ) {
          throw new Error("Symlink target escapes sandbox");
        }
        await fs.symlink(target, linkPath);
        return;
      }

      // ----- Permissions & timestamps -----
      case "chmod": {
        const p = await sandboxPath(root, args[0] as string);
        await fs.chmod(p, args[1] as number);
        return;
      }

      case "chown": {
        const p = await sandboxPath(root, args[0] as string);
        await fs.chown(p, args[1] as number, args[2] as number);
        return;
      }

      case "utimes": {
        const p = await sandboxPath(root, args[0] as string);
        await fs.utimes(p, args[1] as number, args[2] as number);
        return;
      }

      // ----- File handles -----
      case "open": {
        const p = await sandboxPath(root, args[0] as string);
        const flags = (args[1] as string) ?? "r";
        const mode = args[2] as number | undefined;
        const handle = await fs.open(p, flags, mode);
        const handleId = this.trackHandle(handle, panelId);
        return { handleId };
      }

      case "handleRead": {
        const tracked = this.getTrackedHandle(args[0] as number, panelId);
        const length = args[1] as number;
        if (length < 0 || length > MAX_READ_LENGTH) {
          throw new Error(`Read length out of range (max ${MAX_READ_LENGTH})`);
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
        const position = args[2] as number | null ?? null;
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

      default:
        throw new Error(`Unknown fs method: ${method}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Convenience: top-level handler for dispatcher.register("fs", ...)
// ---------------------------------------------------------------------------

export function handleFsCall(
  fsService: FsService,
  ctx: ServiceContext,
  method: string,
  args: unknown[],
): Promise<unknown> {
  return fsService.handleCall(ctx, method, args);
}
