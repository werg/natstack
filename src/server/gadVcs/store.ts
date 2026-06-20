/**
 * GadVcs — GAD-native version control over a working directory (WS3.P1).
 *
 * Replaces the git substrate: `snapshotDir` is commit (scan → hash → CAS →
 * `ingestWorktreeState`), `materializeState` is checkout. The `.gad/`
 * sidecar (`CHECKOUT.json`) is a P1 cache — derivation "stat() of every
 * file at the last snapshot/materialize"; deleting it only costs a rescan.
 *
 * Workspace identity: the whole workspace is ONE log (`vcs:workspace`),
 * head `main`; context folders are `forkLog` children on head
 * `ctx:{contextId}` (same lineage rules as every other log — P5).
 */

import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import { buildWorktreeManifest, type WorktreeManifest } from "@workspace/agentic-protocol";
import { blobPath, ensureLayout, putFile } from "../services/blobstoreService.js";

/** Narrow call surface onto the GadWorkspaceDO (DODispatch server-side, the DO instance in tests). */
export interface GadCaller {
  call<T = unknown>(method: string, input: unknown): Promise<T>;
}

export const VCS_LOG_ID = "vcs:workspace";
export const VCS_MAIN_HEAD = "main";

export function vcsContextHead(contextId: string): string {
  return `ctx:${contextId}`;
}

export function vcsWorktreeRefName(head: string): string {
  return `worktree:${VCS_LOG_ID}:${head}`;
}

/**
 * Directories never snapshotted. These are platform invariants, not user
 * preferences: they contain VCS metadata, dependency caches, generated output,
 * or runtime state that must not enter the durable file graph.
 */
const ALWAYS_IGNORED_DIRS = new Set([
  ".git",
  ".gad",
  ".contexts",
  ".databases",
  ".cache",
  ".parcel-cache",
  ".pnpm-store",
  ".natstack",
  ".turbo",
  ".vite",
  ".tmp",
  ".testkit",
  "node_modules",
  "dist",
  "out",
  "coverage",
  "test-results",
  "dist_electron",
  "release",
]);

/**
 * Worktree file listing the paths of an in-progress merge's conflicts (with
 * their kind). Written into a head's working tree while a merge is pending so
 * non-content conflicts (mode/binary/delete-vs-change) — which leave no in-file
 * `<<<<<<<` markers — are visible to CLI/agent/direct users; removed when the
 * merge resolves or aborts. Ignored by snapshots so it never enters the graph.
 */
export const MERGE_CONFLICTS_FILE = "MERGE_CONFLICTS.md";

/**
 * Reject a state file path that could escape its worktree root when joined onto
 * a directory: absolute, leading slash, any `..` segment, empty, or containing a
 * NUL byte. Called at the edit boundary so attacker-controlled paths never enter
 * GAD state. (Snapshot scans produce safe relative paths by construction.)
 */
export function assertSafeVcsPath(p: string): void {
  if (
    p.length === 0 ||
    p.includes("\0") ||
    p.startsWith("/") ||
    path.isAbsolute(p) ||
    p.split(/[/\\]/).some((seg) => seg === "..")
  ) {
    throw new Error(`vcs path escapes worktree: ${JSON.stringify(p)}`);
  }
}

let platformIgnoreMatcher: { ignores: (s: string) => boolean } | null = null;

/**
 * Reject a new state path that the snapshot scan would itself exclude — VCS
 * internals (`.git`, `.gad`), generated dirs (`node_modules`, `dist`), and
 * secret/env files (`.env`, `.npmrc`, `.secrets.yml`, …). Without this, an
 * edit-ingress caller (vcs.applyEdits) could write such a path into GAD state
 * (the scan denylist only runs on disk→state, not on caller→state), and
 * materializeState would write it to disk — e.g. planting `.git/hooks/*` or a
 * `.env`, or shadowing internal VCS state. Only platform-invariant exclusions
 * are enforced here (not the user's dynamic `.gadignore`).
 */
export async function assertWritableVcsPath(p: string): Promise<void> {
  // Actionable hint: the guard is a denylist (anything not platform-ignored is trackable), so steer
  // callers to a concrete writable location rather than just naming the rejected one.
  const hint =
    "VCS tracks workspace source — write to a non-ignored path (e.g. projects/…, panels/…, packages/…), " +
    "not a platform-ignored dir (.natstack, .git, .gad, .tmp, node_modules, dist) or ignored file (.env, *.log).";
  const segs = p.split("/");
  for (const seg of segs.slice(0, -1)) {
    if (ALWAYS_IGNORED_DIRS.has(seg)) {
      throw new Error(`vcs path is in a platform-ignored directory: ${JSON.stringify(p)}. ${hint}`);
    }
  }
  const base = segs.at(-1) ?? "";
  if (ALWAYS_IGNORED_DIRS.has(base) || ALWAYS_IGNORED_FILES.has(base)) {
    throw new Error(`vcs path is platform-ignored: ${JSON.stringify(p)}. ${hint}`);
  }
  if (!platformIgnoreMatcher) {
    const { default: ignore } = await import("ignore");
    platformIgnoreMatcher = ignore().add(SNAPSHOT_IGNORE_PATTERNS);
  }
  if (platformIgnoreMatcher.ignores(p)) {
    throw new Error(`vcs path is platform-ignored: ${JSON.stringify(p)}. ${hint}`);
  }
}

/**
 * Whether `p` is a GAD-trackable path — i.e. exactly the set `applyEdits`
 * accepts (safe + not platform-ignored). The fs-service reroute uses this to
 * decide whether a context mutation must go through GAD (`applyEdits`) or is a
 * scratch/ignored path (`.tmp`, `.testkit`, `node_modules`, `*.log`, …) that
 * stays a direct disk write.
 */
export async function isWritableVcsPath(p: string): Promise<boolean> {
  try {
    assertSafeVcsPath(p);
    await assertWritableVcsPath(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Join a state path onto a worktree dir and assert the result stays inside it —
 * a defense-in-depth backstop at the on-disk sink so no state (even a
 * pre-existing poisoned one) can ever write/delete outside `dir`.
 */
function safeWorktreeJoin(dir: string, relPath: string): string {
  const abs = path.join(dir, ...relPath.split("/"));
  const base = path.resolve(dir);
  const resolved = path.resolve(abs);
  if (resolved !== base && !resolved.startsWith(base + path.sep)) {
    throw new Error(`vcs path escapes worktree: ${JSON.stringify(relPath)}`);
  }
  return abs;
}

const ALWAYS_IGNORED_FILES = new Set([
  ".DS_Store",
  "Thumbs.db",
  ".npmrc",
  ".secrets.yml",
  "firebase-service-account.json",
  "google-services.json",
  "GoogleService-Info.plist",
]);

const SNAPSHOT_IGNORE_PATTERNS = [
  ".env",
  ".env.*",
  "*.log",
  "*.tmp",
  "*.swp",
  "*.swo",
  "*.sublime-workspace",
  "*~",
  "*.tsbuildinfo",
  "*.tgz",
  ".npmrc.dist-tag-temp",
];

const SIDECAR_DIR = ".gad";
const SIDECAR_FILE = "CHECKOUT.json";

export interface VcsFileEntry {
  path: string;
  contentHash: string;
  size: number;
  mode: number;
}

interface SidecarEntry {
  contentHash: string;
  size: number;
  mtimeMs: number;
  mode: number;
}

interface SidecarState {
  version: 1;
  /** State hash the worktree last agreed with (after snapshot or materialize). */
  stateHash: string | null;
  files: Record<string, SidecarEntry>;
}

export interface SnapshotResult {
  stateHash: string;
  eventId: string;
  headHash: string;
  fileCount: number;
  /** True when the scan found no difference and no ingest was performed. */
  unchanged: boolean;
}

export type VcsActor = { id: string; kind: string };
export type VcsLogActor = {
  id: string;
  kind: "user" | "agent" | "system" | "panel" | "external";
  metadata?: Record<string, unknown>;
};

export function vcsLogActor(actor: VcsActor): VcsLogActor {
  if (
    actor.kind === "user" ||
    actor.kind === "agent" ||
    actor.kind === "system" ||
    actor.kind === "panel" ||
    actor.kind === "external"
  ) {
    return { id: actor.id, kind: actor.kind };
  }
  const kind =
    actor.kind === "do" || actor.kind === "worker"
      ? "agent"
      : actor.kind === "server"
        ? "system"
        : actor.kind === "shell"
          ? "user"
          : "external";
  return { id: actor.id, kind, metadata: { type: actor.kind } };
}

export interface SnapshotOptions {
  head?: string;
  actor?: VcsActor;
  summary?: string;
  metadata?: Record<string, unknown>;
  /** CAS guard forwarded to ingestWorktreeState. */
  expectedRefStateHash?: string | null;
  /** Force ingest even when the scan matches the sidecar's stateHash. */
  force?: boolean;
  /** Extra transition parents (merge-resolution commits). */
  parentStateHashes?: string[];
  /** Transition kind override (merge-resolution commits). */
  eventKind?: "state.snapshot_ingested" | "state.merge_applied";
  beforeIngest?(candidate: {
    head: string;
    previousStateHash: string | null;
    stateHash: string;
    files: VcsFileEntry[];
    fileCount: number;
  }): Promise<void> | void;
}

export interface MaterializeOptions {
  /** Delete files not present in the target state (default: only files the
   *  sidecar says we previously wrote — untracked files are preserved). */
  clean?: boolean;
  /** Directory to keep the `.gad/CHECKOUT.json` sidecar in, instead of inside
   *  `dir`. Used by the git bridge: the checkout tree must contain no `.gad`
   *  (it would be committed), yet the sidecar must persist across exports so
   *  cross-transition deletions are still detected and applied. */
  sidecarDir?: string;
}

export interface MaterializeResult {
  stateHash: string;
  written: number;
  deleted: number;
  unchanged: number;
}

export interface GadVcsDeps {
  blobsDir: string;
  gad: GadCaller;
}

interface ScannedFile {
  path: string;
  absPath: string;
  size: number;
  mtimeMs: number;
  mode: number;
}

async function loadIgnoreMatcher(
  dir: string
): Promise<(relPath: string, isDir: boolean) => boolean> {
  const { default: ignore } = await import("ignore");
  const platformMatcher = ignore().add(SNAPSHOT_IGNORE_PATTERNS);
  let userPatterns: string[] = [];
  try {
    const raw = await fsp.readFile(path.join(dir, ".gadignore"), "utf8");
    userPatterns = raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
  } catch {
    // No workspace policy file; platform exclusions still apply.
  }
  const userMatcher = userPatterns.length > 0 ? ignore().add(userPatterns) : null;
  return (relPath, isDir) => {
    const subject = isDir ? `${relPath}/` : relPath;
    return platformMatcher.ignores(subject) || (userMatcher?.ignores(subject) ?? false);
  };
}

export class GadVcs {
  constructor(private readonly deps: GadVcsDeps) {
    ensureLayout(deps.blobsDir);
  }

  // -------------------------------------------------------------------------
  // Sidecar (P1 cache)
  // -------------------------------------------------------------------------

  private sidecarPath(dir: string, sidecarDir?: string): string {
    return path.join(sidecarDir ?? dir, SIDECAR_DIR, SIDECAR_FILE);
  }

  private async readSidecar(dir: string, sidecarDir?: string): Promise<SidecarState> {
    try {
      const raw = await fsp.readFile(this.sidecarPath(dir, sidecarDir), "utf8");
      const parsed = JSON.parse(raw) as SidecarState;
      if (parsed.version === 1 && parsed.files && typeof parsed.files === "object") {
        return parsed;
      }
    } catch {
      // missing/corrupt sidecar — cache amnesia, full rescan
    }
    return { version: 1, stateHash: null, files: {} };
  }

  private async writeSidecar(dir: string, state: SidecarState, sidecarDir?: string): Promise<void> {
    const sidecarPath = this.sidecarPath(dir, sidecarDir);
    await fsp.mkdir(path.dirname(sidecarPath), { recursive: true });
    const tmp = `${sidecarPath}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
    await fsp.rename(tmp, sidecarPath);
  }

  // -------------------------------------------------------------------------
  // Scan + snapshot (commit)
  // -------------------------------------------------------------------------

  private async scanDir(dir: string): Promise<ScannedFile[]> {
    const ignores = await loadIgnoreMatcher(dir);
    const out: ScannedFile[] = [];
    const walk = async (abs: string, rel: string): Promise<void> => {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      await Promise.all(
        entries.map(async (entry) => {
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          const childAbs = path.join(abs, entry.name);
          if (entry.isDirectory()) {
            if (ALWAYS_IGNORED_DIRS.has(entry.name)) return;
            if (ignores(childRel, true)) return;
            await walk(childAbs, childRel);
          } else if (entry.isFile()) {
            if (ALWAYS_IGNORED_FILES.has(entry.name)) return;
            // Root-only: the merge-conflict summary is written at the worktree
            // root, so ignore it there without shadowing a user's own nested
            // file of the same name (e.g. docs/MERGE_CONFLICTS.md).
            if (childRel === MERGE_CONFLICTS_FILE) return;
            if (ignores(childRel, false)) return;
            const stat = await fsp.stat(childAbs);
            out.push({
              path: childRel,
              absPath: childAbs,
              size: stat.size,
              mtimeMs: stat.mtimeMs,
              mode: stat.mode & 0o111 ? 33261 : 33188,
            });
          }
          // symlinks / sockets / etc. are not part of the GAD file model
        })
      );
    };
    await walk(dir, "");
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Hash every scanned file, using the sidecar's (size, mtime) fast path to
   * skip rehashing unchanged files. Returns the full file list for ingest
   * plus the refreshed sidecar entries.
   */
  private async hashFiles(
    scanned: ScannedFile[],
    sidecar: SidecarState
  ): Promise<{ files: VcsFileEntry[]; entries: Record<string, SidecarEntry> }> {
    const files: VcsFileEntry[] = [];
    const entries: Record<string, SidecarEntry> = {};
    for (const file of scanned) {
      const cached = sidecar.files[file.path];
      let contentHash: string;
      if (cached && cached.size === file.size && cached.mtimeMs === file.mtimeMs) {
        contentHash = cached.contentHash;
      } else {
        contentHash = (await putFile(this.deps.blobsDir, file.absPath)).digest;
      }
      files.push({ path: file.path, contentHash, size: file.size, mode: file.mode });
      entries[file.path] = {
        contentHash,
        size: file.size,
        mtimeMs: file.mtimeMs,
        mode: file.mode,
      };
    }
    return { files, entries };
  }

  /**
   * Scan + hash a working directory entirely locally (blobs enter the CAS,
   * nothing touches the DO). The returned state/subtree hashes are
   * byte-identical to what `ingestWorktreeState` would compute — the shared
   * implementation lives in @workspace/agentic-protocol worktree-hash.ts.
   * This is the bootstrap path: builds can be content-addressed before the
   * gad store is reachable.
   */
  async localState(dir: string): Promise<{
    stateHash: string;
    files: VcsFileEntry[];
    manifest: WorktreeManifest;
  }> {
    const sidecar = await this.readSidecar(dir);
    const scanned = await this.scanDir(dir);
    const { files } = await this.hashFiles(scanned, sidecar);
    const manifest = buildWorktreeManifest(files);
    return { stateHash: manifest.stateHash, files, manifest };
  }

  /**
   * Snapshot a working directory as a `state.snapshot_ingested` transition
   * on the workspace log (the vcs commit). No-ops (without appending) when
   * the scan reproduces the sidecar's last agreed state hash.
   */
  async snapshotDir(dir: string, opts: SnapshotOptions = {}): Promise<SnapshotResult> {
    const head = opts.head ?? VCS_MAIN_HEAD;
    const sidecar = await this.readSidecar(dir);
    const scanned = await this.scanDir(dir);
    const { files, entries } = await this.hashFiles(scanned, sidecar);
    const manifest = buildWorktreeManifest(files);

    // No-change path: the scan reproduces the ref's current state exactly —
    // skip the ingest so scan-on-demand entry points (build, launch_panel)
    // don't append junk snapshot events. Compared against the DURABLE ref
    // state, not the sidecar, so it survives sidecar amnesia (P3). The local
    // manifest hash is byte-identical to the DO state hash, avoiding a full
    // state-file table fetch on every unchanged HTML/build request.
    const refStateHash = await this.resolveWorktreeRef(head);
    if (!opts.force) {
      if (refStateHash && refStateHash === manifest.stateHash) {
        await this.writeSidecar(dir, { version: 1, stateHash: refStateHash, files: entries });
        return {
          stateHash: refStateHash,
          eventId: "",
          headHash: "",
          fileCount: files.length,
          unchanged: true,
        };
      }
    }

    if (opts.beforeIngest) {
      const staged = await this.deps.gad.call<{ stateHash: string }>("stageWorktreeState", {
        files: files.map((file) => ({
          path: file.path,
          contentHash: file.contentHash,
          size: file.size,
          mode: file.mode,
        })),
        ...(opts.summary ? { summary: opts.summary } : {}),
      });
      if (staged.stateHash !== manifest.stateHash) {
        throw new Error(
          `snapshot candidate hash mismatch: ${staged.stateHash} != ${manifest.stateHash}`
        );
      }
      await opts.beforeIngest({
        head,
        previousStateHash: refStateHash,
        stateHash: staged.stateHash,
        files,
        fileCount: files.length,
      });
    }

    const result = await this.deps.gad.call<{
      stateHash: string;
      eventId: string;
      headHash: string;
    }>("ingestWorktreeState", {
      logId: VCS_LOG_ID,
      head,
      logKind: "vcs",
      actor: vcsLogActor(opts.actor ?? { id: "user", kind: "user" }),
      files: files.map((file) => ({
        path: file.path,
        contentHash: file.contentHash,
        size: file.size,
        mode: file.mode,
      })),
      ...(opts.summary ? { summary: opts.summary } : {}),
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
      ...(opts.expectedRefStateHash !== undefined
        ? { expectedRefStateHash: opts.expectedRefStateHash }
        : {}),
      ...(opts.parentStateHashes ? { parentStateHashes: opts.parentStateHashes } : {}),
      ...(opts.eventKind ? { eventKind: opts.eventKind } : {}),
    });

    await this.writeSidecar(dir, { version: 1, stateHash: result.stateHash, files: entries });
    return { ...result, fileCount: files.length, unchanged: false };
  }

  // -------------------------------------------------------------------------
  // Materialize (checkout)
  // -------------------------------------------------------------------------

  /**
   * Write a worktree state into a directory. Incremental: files whose
   * sidecar entry already matches the target hash are left untouched;
   * previously-materialized files absent from the target are deleted.
   * Untracked files are preserved unless `clean`.
   */
  async materializeState(
    stateHash: string,
    dir: string,
    opts: MaterializeOptions = {}
  ): Promise<MaterializeResult> {
    const target = await this.deps.gad.call<
      Array<{ path: string; content_hash: string; mode: number }>
    >("listStateFiles", { stateHash });
    await fsp.mkdir(dir, { recursive: true });
    const sidecar = await this.readSidecar(dir, opts.sidecarDir);
    const entries: Record<string, SidecarEntry> = {};
    let written = 0;
    let unchanged = 0;
    const targetPaths = new Set(target.map((file) => file.path));

    // Deletions FIRST — before any writes. A path can transition type between
    // states (file→dir: old file `foo` becomes the parent of target
    // `foo/bar.ts`; dir→file: old `foo/bar.ts` becomes file `foo`). Deleting
    // stale paths up front, while the on-disk tree still reflects the previous
    // state, means no rm ever traverses a half-transitioned path, and the write
    // loop's freshly-written subtree can't be clobbered by a later deletion of
    // a now-directory path.
    let deleted = 0;
    for (const relPath of Object.keys(sidecar.files)) {
      if (!targetPaths.has(relPath)) {
        await this.rmTolerant(safeWorktreeJoin(dir, relPath));
        deleted += 1;
      }
    }

    for (const file of target) {
      const relPath = file.path;
      const absPath = safeWorktreeJoin(dir, relPath);
      const prev = sidecar.files[relPath];
      let reusable = false;
      if (prev && prev.contentHash === file.content_hash && prev.mode === file.mode) {
        try {
          const stat = await fsp.stat(absPath);
          reusable = stat.size === prev.size && stat.mtimeMs === prev.mtimeMs;
        } catch {
          reusable = false;
        }
      }
      if (reusable && prev) {
        entries[relPath] = prev;
        unchanged += 1;
        continue;
      }
      // An ancestor path component may currently exist on disk as a
      // non-directory (a now-stale file at a path that must become a directory,
      // whether sidecar-tracked or untracked/external) — remove it so the
      // recursive mkdir below can create the directory chain.
      await this.clearNonDirAncestors(dir, relPath);
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
      const source = blobPath(this.deps.blobsDir, file.content_hash);
      // Copy (not hardlink) into the worktree: worktree files are editable
      // and a hardlink would let an editor corrupt the CAS in place.
      await fsp.rm(absPath, { force: true, recursive: true });
      await fsp.copyFile(source, absPath);
      const executable = file.mode === 33261;
      await fsp.chmod(absPath, executable ? 0o755 : 0o644);
      const stat = await fsp.stat(absPath);
      entries[relPath] = {
        contentHash: file.content_hash,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        mode: file.mode,
      };
      written += 1;
    }

    if (opts.clean) {
      // Remove untracked files too (full clean checkout).
      const scanned = await this.scanDir(dir);
      for (const file of scanned) {
        if (!targetPaths.has(file.path)) {
          await fsp.rm(file.absPath, { force: true, recursive: true });
          deleted += 1;
        }
      }
    }
    await this.pruneEmptyDirs(dir);

    await this.writeSidecar(dir, { version: 1, stateHash, files: entries }, opts.sidecarDir);
    return { stateHash, written, deleted, unchanged };
  }

  /** Recursive remove that tolerates a missing path or an ancestor that is not
   *  a directory (ENOENT/ENOTDIR) — both mean "already gone" for our purposes. */
  private async rmTolerant(target: string): Promise<void> {
    try {
      await fsp.rm(target, { force: true, recursive: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
    }
  }

  /** Remove the first ancestor directory component of `relPath` that exists on
   *  disk as a non-directory, so a file→directory transition can materialize. */
  private async clearNonDirAncestors(dir: string, relPath: string): Promise<void> {
    const parts = relPath.split("/");
    let cur = dir;
    for (let i = 0; i < parts.length - 1; i++) {
      cur = path.join(cur, parts[i] ?? "");
      let stat: fs.Stats;
      try {
        stat = await fsp.lstat(cur);
      } catch {
        return; // ancestor doesn't exist yet — recursive mkdir will create it
      }
      if (!stat.isDirectory()) {
        await fsp.rm(cur, { force: true, recursive: true });
        return; // deeper components lived under this now-removed entry
      }
    }
  }

  /**
   * Materialize only the given path prefixes of a state into `dir`
   * (build-source checkouts). The dir is per-state and immutable, so an
   * existing file is trusted as already-correct — no sidecar, no deletions.
   * Hardlinks from the CAS by default: build sources are never edited, and
   * linking makes per-state checkouts nearly free.
   */
  async materializeSubtrees(
    stateHash: string,
    dir: string,
    prefixes: string[],
    opts: { link?: boolean } = {}
  ): Promise<{ written: number }> {
    const target = await this.deps.gad.call<
      Array<{ path: string; content_hash: string; mode: number }>
    >("listStateFiles", { stateHash });
    return this.materializeFileList(target, dir, prefixes, opts);
  }

  /** Same as {@link materializeSubtrees} but over an explicit file list
   *  (bootstrap path: the list comes from a local scan, not the DO). */
  async materializeFileList(
    target: Array<{ path: string; content_hash: string; mode: number }>,
    dir: string,
    prefixes: string[],
    opts: { link?: boolean } = {}
  ): Promise<{ written: number }> {
    const link = opts.link ?? true;
    const wanted =
      prefixes.length === 0
        ? target
        : target.filter((file) =>
            prefixes.some((prefix) => file.path === prefix || file.path.startsWith(`${prefix}/`))
          );
    let written = 0;
    for (const file of wanted) {
      const absPath = safeWorktreeJoin(dir, file.path);
      const source = blobPath(this.deps.blobsDir, file.content_hash);
      const sourceStat = await fsp.stat(source);
      try {
        const existing = await fsp.stat(absPath);
        if (existing.isFile() && existing.size === sourceStat.size) continue;
      } catch {
        // Missing or unreadable: rewrite below.
      }
      await fsp.mkdir(path.dirname(absPath), { recursive: true });
      const executable = file.mode === 33261;
      // Executables are copied (chmod on a hardlink would mutate the shared
      // CAS inode); regular files hardlink with copy fallback.
      await this.writeMaterializedFile(source, absPath, { executable, link });
      written += 1;
    }
    return { written };
  }

  private async writeMaterializedFile(
    source: string,
    absPath: string,
    opts: { executable: boolean; link: boolean }
  ): Promise<void> {
    const tmp = path.join(
      path.dirname(absPath),
      `.${path.basename(absPath)}.${process.pid}.${Date.now()}.tmp`
    );
    await fsp.rm(tmp, { force: true });
    let linked = false;
    if (opts.link && !opts.executable) {
      try {
        await fsp.link(source, tmp);
        linked = true;
      } catch {
        // Fall back below.
      }
    }
    if (!linked) {
      await fsp.copyFile(source, tmp);
      await fsp.chmod(tmp, opts.executable ? 0o755 : 0o644);
    }
    await fsp.rename(tmp, absPath);
  }

  private async pruneEmptyDirs(dir: string): Promise<void> {
    const walk = async (abs: string, depth: number): Promise<boolean> => {
      const entries = await fsp.readdir(abs, { withFileTypes: true });
      let empty = true;
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (depth === 0 && ALWAYS_IGNORED_DIRS.has(entry.name)) {
            empty = false;
            continue;
          }
          const childEmpty = await walk(path.join(abs, entry.name), depth + 1);
          if (childEmpty) {
            await fsp.rmdir(path.join(abs, entry.name)).catch(() => {});
          } else {
            empty = false;
          }
        } else {
          empty = false;
        }
      }
      return empty;
    };
    await walk(dir, 0).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Refs / log / diff passthroughs
  // -------------------------------------------------------------------------

  async resolveWorktreeRef(head: string): Promise<string | null> {
    const ref = await this.deps.gad.call<{ target?: { stateHash?: string } } | null>("resolveRef", {
      refName: vcsWorktreeRefName(head),
    });
    return ref?.target?.stateHash ?? null;
  }

  /** Fork the workspace main head into a context head (no-copy forkLog). */
  async forkContext(contextId: string): Promise<{ head: string; stateHash: string | null }> {
    const head = vcsContextHead(contextId);
    const existing = await this.deps.gad.call<unknown>("getLogHead", {
      logId: VCS_LOG_ID,
      head,
    });
    if (!existing) {
      await this.deps.gad.call("forkLog", {
        fromLogId: VCS_LOG_ID,
        fromHead: VCS_MAIN_HEAD,
        toLogId: VCS_LOG_ID,
        toHead: head,
      });
    }
    return { head, stateHash: await this.resolveWorktreeRef(head) };
  }

  async diffStates(
    leftStateHash: string,
    rightStateHash: string
  ): Promise<{
    added: unknown[];
    removed: unknown[];
    changed: unknown[];
  }> {
    return await this.deps.gad.call("diffGadStates", { leftStateHash, rightStateHash });
  }

  async getSubtreeHash(stateHash: string, subPath: string): Promise<string | null> {
    const result = await this.deps.gad.call<{ subtreeHash: string | null }>("getSubtreeHash", {
      stateHash,
      path: subPath,
    });
    return result.subtreeHash;
  }

  /**
   * Working-tree status: scan + hash against the ref state (NOT the sidecar
   * — the sidecar is only a hashing fast path; status must be true against
   * the durable ref even after cache amnesia).
   */
}
