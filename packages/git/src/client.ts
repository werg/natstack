import git, { STAGE } from "isomorphic-git";
import type { FsClient, HttpClient, GitHttpRequest, GitHttpResponse } from "isomorphic-git";
import { diffLines } from "diff";
import type {
  GitClientOptions,
  CloneOptions,
  PullOptions,
  PushOptions,
  CommitOptions,
  RepoStatus,
  FileStatus,
  StashEntry,
  FileDiff,
  Hunk,
  HunkSelection,
  StageHunksOptions,
  BranchInfo,
  CreateBranchOptions,
  RemoteStatus,
  BlameLine,
  FileHistoryEntry,
  ConflictInfo,
  ConflictMarker,
  ConflictResolution,
} from "./types.js";

export class GitAuthError extends Error {
  statusCode?: number;

  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = "GitAuthError";
    this.statusCode = statusCode;
  }
}

/**
 * Minimal fs/promises interface expected by GitClient.
 * Compatible with Node's fs/promises and @natstack/runtime's RuntimeFs.
 */
export interface FsPromisesLike {
  readFile(path: string, encoding?: BufferEncoding): Promise<Uint8Array | string>;
  writeFile(path: string, data: Uint8Array | string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  rmdir(path: string): Promise<void>;
  stat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean }>;
}

/**
 * Wrap fs/promises-like interface into isomorphic-git's FsClient format.
 * Handles quirks: always recursive mkdir, lstat fallback, symlink stubs.
 */
function wrapFsForGit(fsPromises: FsPromisesLike): FsClient {
  let warnedSymlink = false;
  let warnedReadlink = false;

  const ensureParentDir = async (filePath: string): Promise<void> => {
    try {
      const dir = filePath.slice(0, filePath.lastIndexOf("/"));
      if (dir) {
        await fsPromises.mkdir(dir, { recursive: true });
      }
    } catch {
      // Best effort
    }
  };

  return {
    promises: {
      readFile: async (path: string, opts?: unknown) => {
        if (path === undefined || path === null) {
          const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        const encoding =
          typeof opts === "string" ? opts : (opts as { encoding?: string } | undefined)?.encoding;

        if (!encoding) {
          return await fsPromises.readFile(path);
        }
        return await fsPromises.readFile(path, encoding as BufferEncoding);
      },

      writeFile: async (path: string, data: unknown) => {
        await ensureParentDir(path);
        return fsPromises.writeFile(path, data as Uint8Array | string);
      },

      unlink: async (path: string) => fsPromises.unlink(path),

      readdir: async (path: string) => fsPromises.readdir(path),

      mkdir: async (path: string) => fsPromises.mkdir(path, { recursive: true }),

      rmdir: async (path: string) => fsPromises.rmdir(path),

      stat: async (path: string) => fsPromises.stat(path),

      lstat: async (path: string) => fsPromises.stat(path), // fallback to stat for compatibility

      readlink: async (path: string) => {
        if (!warnedReadlink) {
          console.warn("readlink not supported in fs adapter; returning placeholder");
          warnedReadlink = true;
        }
        return path;
      },

      symlink: async (target: string, linkPath: string) => {
        if (!warnedSymlink) {
          console.warn("symlink not supported in fs adapter; performing best-effort copy");
          warnedSymlink = true;
        }
        try {
          const data = await fsPromises.readFile(target);
          await fsPromises.writeFile(linkPath, data);
        } catch {
          // Ignore if source missing
        }
      },

      chmod: async () => {
        // No-op in fs adapter
      },
    },
  };
}

/**
 * HTTP client for isomorphic-git with bearer token auth
 */
function createHttpClient(token: string): HttpClient {
  return {
    async request(request: GitHttpRequest): Promise<GitHttpResponse> {
      const { url, method = "GET", headers = {}, body } = request;

      // Add bearer token to all requests
      const authHeaders: Record<string, string> = {
        ...headers,
        Authorization: `Bearer ${token}`,
      };

      // Convert body if it's an async iterable
      let requestBody: Uint8Array | undefined;
      if (body) {
        if (body instanceof Uint8Array) {
          requestBody = body;
        } else {
          // Collect async iterable into single buffer
          const chunks: Uint8Array[] = [];
          for await (const chunk of body) {
            chunks.push(chunk);
          }
          const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
          const result = new Uint8Array(totalLength);
          let offset = 0;
          for (const chunk of chunks) {
            result.set(chunk, offset);
            offset += chunk.length;
          }
          requestBody = result;
        }
      }

      const response = await fetch(url, {
        method,
        headers: authHeaders,
        body: requestBody as BodyInit | undefined,
      });

      // Convert response body to async iterable
      const responseBody = response.body
        ? toAsyncIterable(response.body)
        : (async function* () {})();

      return {
        url: response.url,
        method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
      };
    },
  };
}

function getAuthFailureStatus(err: unknown): number | undefined {
  const maybeStatus = (err as { statusCode?: number }).statusCode;
  if (maybeStatus === 401 || maybeStatus === 403) return maybeStatus;
  const message = (err as { message?: string }).message ?? "";
  if (/401|403|auth/i.test(message)) return maybeStatus ?? 401;
  return undefined;
}

/**
 * Convert ReadableStream to AsyncIterableIterator
 */
async function* toAsyncIterable(
  stream: ReadableStream<Uint8Array>
): AsyncIterableIterator<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Check if content is binary by looking for null bytes in first 8KB
 */
function isBinary(content: Uint8Array | string): boolean {
  const bytes = typeof content === "string"
    ? new TextEncoder().encode(content)
    : content;
  const checkLength = Math.min(bytes.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

function getMimeTypeFromPath(filepath: string): string | undefined {
  const ext = filepath.split(".").pop()?.toLowerCase();
  if (!ext) return undefined;
  const map: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    bmp: "image/bmp",
    svg: "image/svg+xml",
    pdf: "application/pdf",
    zip: "application/zip",
    gz: "application/gzip",
  };
  return map[ext];
}

function isImagePath(filepath: string): boolean {
  const mime = getMimeTypeFromPath(filepath);
  return mime?.startsWith("image/") ?? false;
}

function toBase64(data: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(data).toString("base64");
  }
  let binary = "";
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]!);
  }
  return btoa(binary);
}

function toDataUrl(data: Uint8Array, mimeType?: string): string {
  const safeMime = mimeType ?? "application/octet-stream";
  return `data:${safeMime};base64,${toBase64(data)}`;
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 24) |
    (bytes[offset + 1]! << 16) |
    (bytes[offset + 2]! << 8) |
    bytes[offset + 3]!;
}

function readUint16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function getImageDimensions(bytes: Uint8Array, mimeType?: string): { width: number; height: number } | undefined {
  if (bytes.length < 10) return undefined;

  if (mimeType === "image/png" && bytes.length >= 24) {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      const width = readUint32BE(bytes, 16);
      const height = readUint32BE(bytes, 20);
      return { width, height };
    }
  }

  if (mimeType === "image/gif" && bytes.length >= 10) {
    const width = readUint16LE(bytes, 6);
    const height = readUint16LE(bytes, 8);
    return { width, height };
  }

  if (mimeType === "image/jpeg") {
    // JPEG: scan for SOF0/2 markers
    let offset = 2;
    while (offset < bytes.length - 9) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1]!;
      if (marker === 0xc0 || marker === 0xc2) {
        const height = readUint16BE(bytes, offset + 5);
        const width = readUint16BE(bytes, offset + 7);
        return { width, height };
      }
      const size = readUint16BE(bytes, offset + 2);
      if (size < 2) break;
      offset += 2 + size;
    }
  }

  if (mimeType === "image/webp" && bytes.length >= 30) {
    // WEBP container: RIFF....WEBP
    if (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      const chunk = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
      if (chunk === "VP8X" && bytes.length >= 30) {
        const width = 1 + bytes[24]! + (bytes[25]! << 8) + (bytes[26]! << 16);
        const height = 1 + bytes[27]! + (bytes[28]! << 8) + (bytes[29]! << 16);
        return { width, height };
      }
    }
  }

  return undefined;
}

function isFullOid(ref: string): boolean {
  return /^[0-9a-f]{40}$/i.test(ref);
}

/**
 * Result of reading file content from any source (ref, index, working tree)
 */
interface ContentResult {
  content: string;
  exists: boolean;
  raw?: Uint8Array;
}

// Diff size limits - jsdiff handles large files efficiently with Myers algorithm
// but we still want upper bounds for extremely large files
const MAX_DIFF_SIZE = 2 * 1024 * 1024; // 2MB
const MAX_DIFF_LINES = 50000;
const DIFF_CONTEXT_LINES = 3;

/**
 * Generate diff hunks from old and new content using jsdiff (Myers algorithm).
 * Much more efficient than custom LCS - O(ND) time complexity where D is edit distance.
 */
function generateDiff(oldContent: string, newContent: string): Hunk[] {
  // Check for oversized files
  if (oldContent.length > MAX_DIFF_SIZE || newContent.length > MAX_DIFF_SIZE) {
    return [{
      header: "@@ -1,1 +1,1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [{
        type: "context",
        content: "(File too large to diff - showing summary only)",
        oldLineNo: 1,
        newLineNo: 1,
      }],
    }];
  }

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  if (oldLines.length > MAX_DIFF_LINES || newLines.length > MAX_DIFF_LINES) {
    return [{
      header: "@@ -1,1 +1,1 @@",
      oldStart: 1,
      oldLines: 1,
      newStart: 1,
      newLines: 1,
      lines: [{
        type: "context",
        content: `(File has too many lines to diff: ${Math.max(oldLines.length, newLines.length)} lines)`,
        oldLineNo: 1,
        newLineNo: 1,
      }],
    }];
  }

  // Use jsdiff's Myers algorithm implementation
  const changes = diffLines(oldContent, newContent);

  if (changes.length === 0) return [];

  // Convert jsdiff output to our Hunk format with context lines
  const hunks: Hunk[] = [];
  let oldLineNo = 1;
  let newLineNo = 1;

  // First pass: identify change regions
  interface ChangeRegion {
    oldStart: number;
    newStart: number;
    lines: Array<{ type: "add" | "delete" | "context"; content: string; oldLineNo?: number; newLineNo?: number }>;
  }

  let currentRegion: ChangeRegion | null = null;

  for (const change of changes) {
    const lines = change.value.split("\n");
    // diffLines includes trailing newline in value, so last element is empty
    if (lines[lines.length - 1] === "") {
      lines.pop();
    }

    if (change.added) {
      // Start a new region if needed
      if (!currentRegion) {
        currentRegion = {
          oldStart: Math.max(1, oldLineNo - DIFF_CONTEXT_LINES),
          newStart: Math.max(1, newLineNo - DIFF_CONTEXT_LINES),
          lines: [],
        };
        // Add leading context
        const contextStart = Math.max(0, oldLineNo - 1 - DIFF_CONTEXT_LINES);
        for (let i = contextStart; i < oldLineNo - 1; i++) {
          const contextLineOld = i + 1;
          const contextLineNew = newLineNo - (oldLineNo - 1 - i);
          currentRegion.lines.push({
            type: "context",
            content: oldLines[i] ?? "",
            oldLineNo: contextLineOld,
            newLineNo: contextLineNew,
          });
        }
      }

      for (const line of lines) {
        currentRegion.lines.push({
          type: "add",
          content: line,
          newLineNo: newLineNo,
        });
        newLineNo++;
      }
    } else if (change.removed) {
      // Start a new region if needed
      if (!currentRegion) {
        currentRegion = {
          oldStart: Math.max(1, oldLineNo - DIFF_CONTEXT_LINES),
          newStart: Math.max(1, newLineNo - DIFF_CONTEXT_LINES),
          lines: [],
        };
        // Add leading context
        const contextStart = Math.max(0, oldLineNo - 1 - DIFF_CONTEXT_LINES);
        for (let i = contextStart; i < oldLineNo - 1; i++) {
          const contextLineOld = i + 1;
          const contextLineNew = newLineNo - (oldLineNo - 1 - i);
          currentRegion.lines.push({
            type: "context",
            content: oldLines[i] ?? "",
            oldLineNo: contextLineOld,
            newLineNo: contextLineNew,
          });
        }
      }

      for (const line of lines) {
        currentRegion.lines.push({
          type: "delete",
          content: line,
          oldLineNo: oldLineNo,
        });
        oldLineNo++;
      }
    } else {
      // Unchanged lines
      if (currentRegion) {
        // Add trailing context and possibly close the region
        const contextToAdd = Math.min(lines.length, DIFF_CONTEXT_LINES);
        for (let i = 0; i < contextToAdd; i++) {
          currentRegion.lines.push({
            type: "context",
            content: lines[i] ?? "",
            oldLineNo: oldLineNo + i,
            newLineNo: newLineNo + i,
          });
        }

        // If we have more unchanged lines than 2x context, close this hunk
        if (lines.length > DIFF_CONTEXT_LINES * 2) {
          // Finalize hunk
          const oldCount = currentRegion.lines.filter(l => l.type !== "add").length;
          const newCount = currentRegion.lines.filter(l => l.type !== "delete").length;
          currentRegion.lines.forEach(l => {
            // Ensure line numbers are set for context lines
            if (l.type === "context" && l.oldLineNo === undefined) {
              l.oldLineNo = oldLineNo;
              l.newLineNo = newLineNo;
            }
          });
          hunks.push({
            header: `@@ -${currentRegion.oldStart},${oldCount} +${currentRegion.newStart},${newCount} @@`,
            oldStart: currentRegion.oldStart,
            oldLines: oldCount,
            newStart: currentRegion.newStart,
            newLines: newCount,
            lines: currentRegion.lines,
          });
          currentRegion = null;
        }
      }

      oldLineNo += lines.length;
      newLineNo += lines.length;
    }
  }

  // Finalize any remaining region
  if (currentRegion) {
    const oldCount = currentRegion.lines.filter(l => l.type !== "add").length;
    const newCount = currentRegion.lines.filter(l => l.type !== "delete").length;
    hunks.push({
      header: `@@ -${currentRegion.oldStart},${oldCount} +${currentRegion.newStart},${newCount} @@`,
      oldStart: currentRegion.oldStart,
      oldLines: oldCount,
      newStart: currentRegion.newStart,
      newLines: newCount,
      lines: currentRegion.lines,
    });
  }

  return hunks;
}

function normalizeHunkSelections(selections: Array<{ hunkIndex: number; lineIndices?: number[] }>): Map<number, Set<number> | null> {
  const map = new Map<number, Set<number> | null>();
  for (const selection of selections) {
    if (selection.lineIndices === undefined) {
      map.set(selection.hunkIndex, null);
      continue;
    }
    const existing = map.get(selection.hunkIndex);
    if (existing === null) continue;
    const next = existing ?? new Set<number>();
    for (const idx of selection.lineIndices) {
      next.add(idx);
    }
    map.set(selection.hunkIndex, next);
  }
  return map;
}

function applyHunks(
  oldContent: string,
  hunks: Hunk[],
  selections: Array<{ hunkIndex: number; lineIndices?: number[] }>
): string {
  const selectionMap = normalizeHunkSelections(selections);
  const oldLines = oldContent.split("\n");
  const output: string[] = [];
  let cursor = 1;

  for (let hunkIndex = 0; hunkIndex < hunks.length; hunkIndex++) {
    const hunk = hunks[hunkIndex]!;
    while (cursor < hunk.oldStart) {
      output.push(oldLines[cursor - 1] ?? "");
      cursor++;
    }

    const selection = selectionMap.get(hunkIndex);
    const applyAll = selection === null;
    const selectedLines = selection ?? undefined;

    for (let lineIndex = 0; lineIndex < hunk.lines.length; lineIndex++) {
      const line = hunk.lines[lineIndex]!;
      if (line.type === "context") {
        output.push(line.content);
        cursor++;
        continue;
      }

      const apply = applyAll || (selectedLines?.has(lineIndex) ?? false);

      if (line.type === "delete") {
        if (!apply) {
          output.push(line.content);
        }
        cursor++;
      } else if (line.type === "add") {
        if (apply) {
          output.push(line.content);
        }
      }
    }
  }

  while (cursor <= oldLines.length) {
    output.push(oldLines[cursor - 1] ?? "");
    cursor++;
  }

  return output.join("\n");
}

interface BlameCommitInfo {
  oid: string;
  author: string;
  email: string;
  timestamp: number;
  summary: string;
}

interface BlameEntry {
  content: string;
  commit: BlameCommitInfo;
}

function applyBlameDiff(
  oldEntries: BlameEntry[],
  newContent: string,
  commit: BlameCommitInfo
): BlameEntry[] {
  if (oldEntries.length === 0) {
    return newContent.split("\n").map((line) => ({ content: line, commit }));
  }

  const oldContent = oldEntries.map((entry) => entry.content).join("\n");
  const hunks = generateDiff(oldContent, newContent);
  const output: BlameEntry[] = [];
  let cursor = 1;

  for (const hunk of hunks) {
    while (cursor < hunk.oldStart) {
      const entry = oldEntries[cursor - 1];
      if (entry) output.push(entry);
      cursor++;
    }

    for (const line of hunk.lines) {
      if (line.type === "context") {
        const entry = oldEntries[cursor - 1];
        if (entry) output.push(entry);
        cursor++;
      } else if (line.type === "delete") {
        cursor++;
      } else if (line.type === "add") {
        output.push({ content: line.content, commit });
      }
    }
  }

  while (cursor <= oldEntries.length) {
    const entry = oldEntries[cursor - 1];
    if (entry) output.push(entry);
    cursor++;
  }

  return output;
}

function parseConflictMarkers(content: string): {
  base: string;
  ours: string;
  theirs: string;
  markers: ConflictMarker[];
} {
  const lines = content.split("\n");
  const baseLines: string[] = [];
  const ourLines: string[] = [];
  const theirLines: string[] = [];
  const markers: ConflictMarker[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (!line.startsWith("<<<<<<<")) {
      baseLines.push(line);
      ourLines.push(line);
      theirLines.push(line);
      i++;
      continue;
    }

    const startLine = i + 1;
    i++;
    const oursStart = i + 1;
    const ours: string[] = [];
    while (i < lines.length && !lines[i]!.startsWith("|||||||") && !lines[i]!.startsWith("=======")) {
      ours.push(lines[i]!);
      i++;
    }
    const oursEnd = i;

    let base: string[] = [];
    if (i < lines.length && lines[i]!.startsWith("|||||||")) {
      i++;
      while (i < lines.length && !lines[i]!.startsWith("=======")) {
        base.push(lines[i]!);
        i++;
      }
    }

    if (i < lines.length && lines[i]!.startsWith("=======")) {
      i++;
    }

    const theirsStart = i + 1;
    const theirs: string[] = [];
    while (i < lines.length && !lines[i]!.startsWith(">>>>>>>")) {
      theirs.push(lines[i]!);
      i++;
    }
    const theirsEnd = i;
    const endLine = i + 1;

    if (i < lines.length && lines[i]!.startsWith(">>>>>>>")) {
      i++;
    }

    markers.push({
      startLine,
      endLine,
      oursStart,
      oursEnd,
      theirsStart,
      theirsEnd,
    });

    baseLines.push(...(base.length > 0 ? base : ours));
    ourLines.push(...ours);
    theirLines.push(...theirs);
  }

  return {
    base: baseLines.join("\n"),
    ours: ourLines.join("\n"),
    theirs: theirLines.join("\n"),
    markers,
  };
}

/**
 * Git client for panel filesystem operations
 *
 * Wraps isomorphic-git with:
 * - Bearer token authentication for NatStack git server
 * - Filesystem integration (automatically adapts fs/promises)
 * - Simplified API for common operations
 *
 * @example
 * ```typescript
 * import { promises as fsPromises } from "fs";
 * const git = new GitClient(fsPromises, { serverUrl, token });
 * ```
 */
export class GitClient {
  private fs: FsClient;
  private fsPromises: FsPromisesLike;
  private http: HttpClient;
  private serverUrl: string;
  private author: { name: string; email: string };

  constructor(fs: FsPromisesLike, options: GitClientOptions) {
    this.fs = wrapFsForGit(fs);
    this.fsPromises = fs;
    this.serverUrl = options.serverUrl;
    this.http = createHttpClient(options.token);
    this.author = options.author ?? {
      name: "NatStack Panel",
      email: "panel@natstack.local",
    };
  }

  /**
   * Resolve a repo path to a full URL
   * - Absolute URLs pass through unchanged
   * - Relative paths are resolved against the git server
   */
  resolveUrl(repoPath: string): string {
    if (repoPath.startsWith("http://") || repoPath.startsWith("https://")) {
      return repoPath;
    }
    // Remove leading slash if present
    const cleanPath = repoPath.startsWith("/") ? repoPath.slice(1) : repoPath;
    return `${this.serverUrl}/${cleanPath}`;
  }


  /**
   * Clone a repository
   *
   * Handles both branch refs and commit hashes:
   * - Branch refs: Uses shallow clone (depth: 1) for efficiency
   * - Commit hashes: Must use full clone since git servers can't serve
   *   arbitrary commits via shallow clone (only branch tips are accessible)
   */
  async clone(options: CloneOptions): Promise<void> {
    const url = this.resolveUrl(options.url);

    // Detect if ref is a commit hash (40 hex chars)
    // Shallow clones don't work with commit hashes - git servers can only
    // serve branch tips, not arbitrary commits, via shallow fetch
    const isCommitHash = options.ref && isFullOid(options.ref);

    if (isCommitHash) {
      // For commit hashes: do a full clone (no depth limit), then checkout
      // We clone without ref to get the default branch, then checkout the commit
      await git.clone({
        fs: this.fs,
        http: this.http,
        dir: options.dir,
        url,
        // Don't pass commit hash as ref - it's not a branch
        ref: undefined,
        singleBranch: false, // Need all refs to ensure commit is reachable
        // No depth limit - need full history to find the commit
        depth: undefined,
        noCheckout: true,
      });

      // Checkout the specific commit
      await git.checkout({
        fs: this.fs,
        dir: options.dir,
        ref: options.ref,
        force: true,
      });
    } else {
      // For branch refs: use shallow clone for efficiency
      await git.clone({
        fs: this.fs,
        http: this.http,
        dir: options.dir,
        url,
        ref: options.ref,
        singleBranch: options.singleBranch ?? true,
        depth: options.depth ?? 1,
        // Don't fail if ref doesn't exist - we'll checkout after
        noCheckout: !!options.ref,
      });

      // If a specific ref was requested, checkout to it
      if (options.ref) {
        try {
          await git.checkout({
            fs: this.fs,
            dir: options.dir,
            ref: options.ref,
          });
        } catch {
          // If checkout fails, try with force
          await git.checkout({
            fs: this.fs,
            dir: options.dir,
            ref: options.ref,
            force: true,
          });
        }
      }
    }
  }

  /**
   * Pull latest changes from remote
   */
  async pull(options: PullOptions): Promise<void> {
    const author = options.author ?? this.author;
    const onProgress = options.onProgress
      ? (progress: { phase?: string; loaded?: number; total?: number }) => {
          options.onProgress?.({
            phase: progress.phase ?? "unknown",
            loaded: progress.loaded ?? 0,
            total: progress.total ?? 0,
          });
        }
      : undefined;

    try {
      await git.pull({
        fs: this.fs,
        http: this.http,
        dir: options.dir,
        remote: options.remote ?? "origin",
        ref: options.ref,
        singleBranch: true,
        author,
        onProgress,
      });
    } catch (err) {
      const status = getAuthFailureStatus(err);
      if (status) {
        throw new GitAuthError("Authentication failed. Please check your credentials.", status);
      }
      throw err;
    }
  }

  /**
   * Fetch without merging
   */
  async fetch(options: { dir: string; remote?: string; ref?: string }): Promise<void> {
    await git.fetch({
      fs: this.fs,
      http: this.http,
      dir: options.dir,
      remote: options.remote ?? "origin",
      ref: options.ref,
      singleBranch: true,
    });
  }

  /**
   * Push changes to remote
   */
  async push(options: PushOptions): Promise<void> {
    const onProgress = options.onProgress
      ? (progress: { phase?: string; loaded?: number; total?: number }) => {
          options.onProgress?.({
            phase: progress.phase ?? "unknown",
            loaded: progress.loaded ?? 0,
            total: progress.total ?? 0,
          });
        }
      : undefined;

    try {
      await git.push({
        fs: this.fs,
        http: this.http,
        dir: options.dir,
        remote: options.remote ?? "origin",
        ref: options.ref,
        force: options.force ?? false,
        onProgress,
      });
    } catch (err) {
      const status = getAuthFailureStatus(err);
      if (status) {
        throw new GitAuthError("Authentication failed. Please check your credentials.", status);
      }
      throw err;
    }
  }

  /**
   * Stage a file for commit
   * Handles deleted files by using git.remove() instead of git.add()
   */
  async add(dir: string, filepath: string): Promise<void> {
    // Check if file exists in working tree
    let fileExists = true;
    try {
      await this.fsPromises.stat(`${dir}/${filepath}`);
    } catch {
      fileExists = false;
    }

    if (fileExists) {
      await git.add({
        fs: this.fs,
        dir,
        filepath,
      });
    } else {
      // File was deleted - use git.remove to stage the deletion
      await git.remove({
        fs: this.fs,
        dir,
        filepath,
      });
    }
  }

  /**
   * Stage all changes
   */
  async addAll(dir: string): Promise<void> {
    // Get status to find all changed files
    const status = await this.status(dir);

    for (const file of status.files) {
      if (file.status === "deleted") {
        await git.remove({
          fs: this.fs,
          dir,
          filepath: file.path,
        });
      } else if (file.status !== "unmodified" && file.status !== "ignored") {
        await git.add({
          fs: this.fs,
          dir,
          filepath: file.path,
        });
      }
    }
  }

  /**
   * Create a commit
   */
  async commit(options: CommitOptions): Promise<string> {
    const author = options.author ?? this.author;

    const sha = await git.commit({
      fs: this.fs,
      dir: options.dir,
      message: options.message,
      author,
    });

    return sha;
  }

  /**
   * Get repository status
   */
  async status(dir: string): Promise<RepoStatus> {
    // Get current branch
    let branch: string | null = null;
    try {
      const branchResult = await git.currentBranch({
        fs: this.fs,
        dir,
        fullname: false,
      });
      branch = branchResult ?? null;
    } catch {
      // Might be in detached HEAD state
    }

    // Get current commit
    let commit: string | null = null;
    try {
      commit = await git.resolveRef({
        fs: this.fs,
        dir,
        ref: "HEAD",
      });
    } catch {
      // Empty repo
    }

    // Get file statuses
    const matrix = await git.statusMatrix({
      fs: this.fs,
      dir,
    });

    const files: FileStatus[] = matrix.map(([filepath, head, workdir, stage]) => {
      // Status matrix: [filepath, HEAD, WORKDIR, STAGE]
      // Values are version numbers (0=absent, 1=HEAD, 2=WORKDIR, 3=unique)
      // - HEAD:    0 = absent, 1 = present
      // - WORKDIR: 0 = absent, 1 = same as HEAD, 2 = different from HEAD
      // - STAGE:   0 = absent, 1 = same as HEAD, 2 = same as WORKDIR, 3 = unique (differs from both)
      //
      // Key insight: stage=2 means INDEX === WORKDIR (fully staged)
      //              stage=3 means INDEX !== WORKDIR (has unstaged changes after staging)

      // File is staged if the index differs from HEAD
      const staged =
        (head === 1 && stage === 0) || // Deleted from index
        (head === 1 && stage === 2) || // Modified, fully staged (index === workdir)
        (head === 1 && stage === 3) || // Modified, staged with additional unstaged changes
        (head === 0 && stage === 2) || // New file, fully staged
        (head === 0 && stage === 3);   // New file, staged with additional unstaged changes

      // File is unstaged if the working tree differs from the index
      // stage=2 means index === workdir, so NO unstaged changes
      // stage=3 means index !== workdir, so HAS unstaged changes
      // stage=1 means index === HEAD, so unstaged if workdir !== HEAD
      // stage=0 means not in index, so unstaged if file exists in workdir
      const unstaged =
        stage === 3 || // Index differs from workdir - has unstaged changes after staging
        (stage === 1 && workdir !== 1) || // Index=HEAD but workdir differs (modified or deleted in workdir)
        (stage === 0 && workdir === 2); // Not in index, but exists in workdir (untracked)

      // Determine file status based on HEAD and WORKDIR states
      let status: FileStatus["status"] = "unmodified";

      if (head === 0 && workdir === 2) {
        // File not in HEAD but exists in workdir
        status = staged ? "added" : "untracked";
      } else if (head === 1 && workdir === 0) {
        // File in HEAD but not in workdir
        status = "deleted";
      } else if (head === 1 && workdir === 2) {
        // File in both HEAD and workdir but different
        status = "modified";
      } else if (head === 0 && stage === 2) {
        // New file only in index
        status = "added";
      } else if (head === 1 && stage === 0) {
        // File deleted in index
        status = "deleted";
      } else if (staged || unstaged) {
        // Fallback: if file has staged or unstaged changes but didn't match above,
        // it's modified. This handles edge cases like: stage changes, then reset
        // working tree to HEAD (workdir=1 but index differs from HEAD).
        status = "modified";
      }

      return {
        path: filepath,
        status,
        staged,
        unstaged,
      };
    });

    const dirty = files.some(
      (f) => f.status !== "unmodified" && f.status !== "ignored"
    );

    return {
      branch,
      commit,
      dirty,
      files,
    };
  }

  /**
   * Checkout a ref (branch, tag, or commit)
   */
  async checkout(dir: string, ref: string): Promise<void> {
    await git.checkout({
      fs: this.fs,
      dir,
      ref,
    });
  }

  /**
   * Get the current commit hash
   */
  async getCurrentCommit(dir: string): Promise<string | null> {
    try {
      return await git.resolveRef({
        fs: this.fs,
        dir,
        ref: "HEAD",
      });
    } catch {
      return null;
    }
  }

  /**
   * Get the current branch name
   */
  async getCurrentBranch(dir: string): Promise<string | null> {
    try {
      const result = await git.currentBranch({
        fs: this.fs,
        dir,
        fullname: false,
      });
      return result ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Check if a directory is a git repository
   */
  async isRepo(dir: string): Promise<boolean> {
    try {
      await git.findRoot({
        fs: this.fs,
        filepath: dir,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Initialize a new repository
   */
  async init(dir: string, defaultBranch: string = "main"): Promise<void> {
    await git.init({
      fs: this.fs,
      dir,
      defaultBranch,
    });
  }

  /**
   * Add a remote
   */
  async addRemote(
    dir: string,
    name: string,
    url: string
  ): Promise<void> {
    await git.addRemote({
      fs: this.fs,
      dir,
      remote: name,
      url: this.resolveUrl(url),
    });
  }

  /**
   * List remotes
   */
  async listRemotes(dir: string): Promise<Array<{ remote: string; url: string }>> {
    return git.listRemotes({
      fs: this.fs,
      dir,
    });
  }

  /**
   * List local or remote branches
   */
  async listBranches(dir: string, options?: { remote?: boolean }): Promise<BranchInfo[]> {
    const current = await this.getCurrentBranch(dir);

    if (options?.remote) {
      const remotes = await git.listRemotes({ fs: this.fs, dir });
      const remoteBranches: BranchInfo[] = [];
      for (const remote of remotes) {
        const branches = await git.listBranches({
          fs: this.fs,
          dir,
          remote: remote.remote,
        });
        for (const branch of branches) {
          remoteBranches.push({
            name: branch,
            current: false,
            remote: remote.remote,
            upstream: `${remote.remote}/${branch}`,
          });
        }
      }
      return remoteBranches;
    }

    const branches = await git.listBranches({ fs: this.fs, dir });
    return branches.map((branch) => ({
      name: branch,
      current: branch === current,
    }));
  }

  /**
   * Create a branch
   */
  async createBranch(options: CreateBranchOptions): Promise<void> {
    await git.branch({
      fs: this.fs,
      dir: options.dir,
      ref: options.name,
      object: options.startPoint ?? "HEAD",
      checkout: options.checkout ?? false,
    });
  }

  /**
   * Delete a branch
   */
  async deleteBranch(dir: string, name: string): Promise<void> {
    await git.deleteBranch({
      fs: this.fs,
      dir,
      ref: name,
    });
  }

  private async getUpstreamConfig(
    dir: string,
    branch: string
  ): Promise<{ remote: string; merge: string } | null> {
    try {
      const remote = await git.getConfig({
        fs: this.fs,
        dir,
        path: `branch.${branch}.remote`,
      });
      const merge = await git.getConfig({
        fs: this.fs,
        dir,
        path: `branch.${branch}.merge`,
      });
      if (!remote || !merge) return null;
      return { remote, merge };
    } catch {
      return null;
    }
  }

  /**
   * Get ahead/behind counts against upstream
   */
  async getBranchTracking(
    dir: string,
    branch: string
  ): Promise<{ ahead: number; behind: number } | null> {
    const upstream = await this.getUpstreamConfig(dir, branch);
    if (!upstream) return null;

    const remoteBranch = upstream.merge.replace("refs/heads/", "");
    const remoteRef = `refs/remotes/${upstream.remote}/${remoteBranch}`;
    const localRef = `refs/heads/${branch}`;

    try {
      const [localOid, remoteOid] = await Promise.all([
        git.resolveRef({ fs: this.fs, dir, ref: localRef }),
        git.resolveRef({ fs: this.fs, dir, ref: remoteRef }),
      ]);

      const bases = await git.findMergeBase({
        fs: this.fs,
        dir,
        oids: [localOid, remoteOid],
      });
      const baseOid = bases[0];
      if (!baseOid) return null;

      const maxDepth = 2000;
      const [localLog, remoteLog] = await Promise.all([
        git.log({ fs: this.fs, dir, ref: localOid, depth: maxDepth }),
        git.log({ fs: this.fs, dir, ref: remoteOid, depth: maxDepth }),
      ]);

      const ahead = localLog.findIndex((c) => c.oid === baseOid);
      const behind = remoteLog.findIndex((c) => c.oid === baseOid);

      return {
        ahead: ahead === -1 ? localLog.length : ahead,
        behind: behind === -1 ? remoteLog.length : behind,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get remote status for current branch
   */
  async getRemoteStatus(dir: string): Promise<RemoteStatus | null> {
    const branch = await this.getCurrentBranch(dir);
    if (!branch) return null;

    const upstream = await this.getUpstreamConfig(dir, branch);
    if (!upstream) return null;

    const tracking = await this.getBranchTracking(dir, branch);
    if (!tracking) return null;

    const remoteBranch = upstream.merge.replace("refs/heads/", "");

    return {
      ahead: tracking.ahead,
      behind: tracking.behind,
      diverged: tracking.ahead > 0 && tracking.behind > 0,
      remote: upstream.remote,
      remoteBranch,
    };
  }

  /**
   * Get log of commits
   */
  async log(
    dir: string,
    options?: { depth?: number; ref?: string }
  ): Promise<Array<{ oid: string; message: string; author: { name: string; email: string; timestamp: number } }>> {
    const commits = await git.log({
      fs: this.fs,
      dir,
      depth: options?.depth ?? 10,
      ref: options?.ref ?? "HEAD",
    });

    return commits.map((c) => ({
      oid: c.oid,
      message: c.commit.message,
      author: {
        name: c.commit.author.name,
        email: c.commit.author.email,
        timestamp: c.commit.author.timestamp,
      },
    }));
  }

  /**
   * Blame a file (line-by-line attribution)
   */
  async blame(dir: string, filepath: string, ref: string = "HEAD"): Promise<BlameLine[]> {
    const maxDepth = 500;
    const commits = await git.log({
      fs: this.fs,
      dir,
      ref,
      filepath,
      follow: true,
      depth: maxDepth,
    });

    if (commits.length === 0) return [];

    const history = commits.slice().reverse();
    let entries: BlameEntry[] = [];

    for (const commit of history) {
      const commitInfo: BlameCommitInfo = {
        oid: commit.oid,
        author: commit.commit.author.name,
        email: commit.commit.author.email,
        timestamp: commit.commit.author.timestamp,
        summary: commit.commit.message.split("\n")[0] ?? "",
      };

      const result = await this.readFromRef(dir, filepath, commit.oid);
      if (!result.exists) {
        entries = [];
        continue;
      }
      if (isBinary(result.raw ?? result.content)) {
        return [];
      }

      entries = applyBlameDiff(entries, result.content, commitInfo);
    }

    return entries.map((entry, index) => ({
      lineNumber: index + 1,
      content: entry.content,
      commit: entry.commit.oid,
      author: entry.commit.author,
      email: entry.commit.email,
      timestamp: entry.commit.timestamp,
      summary: entry.commit.summary,
    }));
  }

  /**
   * Get commit history for a file
   */
  async getFileHistory(
    dir: string,
    filepath: string,
    options?: { depth?: number }
  ): Promise<FileHistoryEntry[]> {
    const commits = await git.log({
      fs: this.fs,
      dir,
      filepath,
      follow: true,
      depth: options?.depth ?? 30,
    });

    return commits.map((commit) => ({
      commit: commit.oid,
      author: {
        name: commit.commit.author.name,
        email: commit.commit.author.email,
        timestamp: commit.commit.author.timestamp,
      },
      message: commit.commit.message,
    }));
  }

  // ===========================================================================
  // Unified Content Readers
  // ===========================================================================

  /**
   * Read file content from a git ref (commit, HEAD, branch, tag)
   */
  private async readFromRef(dir: string, filepath: string, ref: string = "HEAD"): Promise<ContentResult> {
    try {
      const commitOid = isFullOid(ref)
        ? ref
        : await git.resolveRef({
            fs: this.fs,
            dir,
            ref,
          });

      const { blob } = await git.readBlob({
        fs: this.fs,
        dir,
        oid: commitOid,
        filepath,
      });

      return { content: new TextDecoder().decode(blob), exists: true, raw: blob };
    } catch (err) {
      // NotFoundError means file doesn't exist at ref - that's expected
      // Other errors (invalid ref, corrupted repo) also result in no content
      const error = err as { code?: string; name?: string };
      if (error.code !== "NotFoundError" && error.name !== "NotFoundError") {
        console.warn(`Failed to read ${filepath} from ${ref}:`, err);
      }
      return { content: "", exists: false };
    }
  }

  /**
   * Read file content from the git index (staging area)
   */
  private async readFromIndex(dir: string, filepath: string): Promise<ContentResult> {
    // Normalize the filepath to match how git stores paths (forward slashes, no leading ./)
    const normalizedPath = filepath.replace(/\\/g, "/").replace(/^\.\//, "");

    try {
      const results = (await git.walk({
        fs: this.fs,
        dir,
        trees: [STAGE()],
        map: async (path, [stage]) => {
          if (path !== normalizedPath) return undefined;
          if (!stage) return { content: "", exists: false };

          // Try to get content directly first
          const content = await stage.content();
          if (content !== null && content !== undefined) {
            // Got content directly - return it
            return { content: new TextDecoder().decode(content), exists: true, raw: content };
          }

          // content() returned null - try reading blob by OID
          const oid = await stage.oid();
          if (!oid) {
            return { content: "", exists: false };
          }

          // Signal that we have an OID but need to read the blob separately
          return { oid, exists: true };
        },
      })) as Array<ContentResult & { oid?: string } | undefined>;

      const hit = results.find((r) => r !== undefined);
      if (!hit) {
        // File not found in index - this is expected for untracked files
        // but unexpected for files that have been staged
        return { content: "", exists: false };
      }

      // If we got content directly, return it
      if (hit.content !== undefined) {
        return hit as ContentResult;
      }

      // Otherwise read the blob by OID
      if (hit.oid) {
        try {
          const { blob } = await git.readBlob({
            fs: this.fs,
            dir,
            oid: hit.oid,
          });
          return { content: new TextDecoder().decode(blob), exists: true, raw: blob };
        } catch {
          // Blob not found - shouldn't happen but handle gracefully
          return { content: "", exists: false };
        }
      }

      return { content: "", exists: false };
    } catch (err) {
      console.warn(`Failed to read index for ${filepath}:`, err);
      return { content: "", exists: false };
    }
  }

  /**
   * Read file content from the working tree (filesystem)
   */
  private async readFromWorkingTree(dir: string, filepath: string): Promise<ContentResult> {
    try {
      const content = await this.fsPromises.readFile(`${dir}/${filepath}`);
      const text = typeof content === "string" ? content : new TextDecoder().decode(content);
      return { content: text, exists: true, raw: typeof content === "string" ? undefined : content };
    } catch (err) {
      // ENOENT means file doesn't exist - expected for deleted files
      const error = err as { code?: string };
      if (error.code !== "ENOENT") {
        // Log unexpected errors (permissions, I/O, etc.) for debugging
        console.warn(`Failed to read working tree file ${filepath}:`, err);
      }
      return { content: "", exists: false };
    }
  }

  // ===========================================================================
  // Unified Diff Builder
  // ===========================================================================

  /**
   * Build a FileDiff from old and new content results
   */
  private buildDiff(filepath: string, oldResult: ContentResult, newResult: ContentResult): FileDiff {
    const oldProbe = oldResult.raw ?? oldResult.content;
    const newProbe = newResult.raw ?? newResult.content;
    const binary = isBinary(oldProbe) || isBinary(newProbe);

    const oldSize = oldResult.raw
      ? oldResult.raw.length
      : new TextEncoder().encode(oldResult.content).length;
    const newSize = newResult.raw
      ? newResult.raw.length
      : new TextEncoder().encode(newResult.content).length;
    const mimeType = getMimeTypeFromPath(filepath);
    const isImage = binary && isImagePath(filepath);

    const binaryInfo = binary
      ? {
          oldSize,
          newSize,
          sizeDelta: newSize - oldSize,
          mimeType,
          isImage,
        }
      : undefined;

    const imageDiff = isImage
      ? {
          oldDataUrl: oldResult.raw ? toDataUrl(oldResult.raw, mimeType) : undefined,
          newDataUrl: newResult.raw ? toDataUrl(newResult.raw, mimeType) : undefined,
          oldDimensions: oldResult.raw ? getImageDimensions(oldResult.raw, mimeType) : undefined,
          newDimensions: newResult.raw ? getImageDimensions(newResult.raw, mimeType) : undefined,
        }
      : undefined;

    return {
      path: filepath,
      oldContent: oldResult.content,
      newContent: newResult.content,
      hunks: binary ? [] : generateDiff(oldResult.content, newResult.content),
      binary,
      binaryInfo,
      imageDiff,
    };
  }

  // ===========================================================================
  // Public API (backwards compatible)
  // ===========================================================================

  /**
   * Get file content at a specific ref (for diff "old" side)
   * @deprecated Use readFromRef internally; kept for backwards compatibility
   */
  async show(dir: string, filepath: string, ref: string = "HEAD"): Promise<string> {
    const result = await this.readFromRef(dir, filepath, ref);
    return result.content;
  }

  /**
   * Get diff for a file (unstaged changes - working tree vs index/HEAD)
   */
  async getWorkingDiff(dir: string, filepath: string): Promise<FileDiff> {
    // Unstaged diff: compare working tree against index (or HEAD if not in index)
    const indexResult = await this.readFromIndex(dir, filepath);

    // If file is in index, compare against index content
    // If not in index, compare against HEAD
    const oldResult = indexResult.exists
      ? indexResult
      : await this.readFromRef(dir, filepath);
    const newResult = await this.readFromWorkingTree(dir, filepath);

    return this.buildDiff(filepath, oldResult, newResult);
  }

  /**
   * Get diff for a staged file (index vs HEAD)
   */
  async getStagedDiff(dir: string, filepath: string): Promise<FileDiff> {
    // Staged diff: compare index against HEAD
    const oldResult = await this.readFromRef(dir, filepath);
    const newResult = await this.readFromIndex(dir, filepath);

    return this.buildDiff(filepath, oldResult, newResult);
  }

  /**
   * Unstage a file (git reset HEAD <file>)
   */
  async unstage(dir: string, filepath: string): Promise<void> {
    const headResult = await this.readFromRef(dir, filepath, "HEAD");

    if (headResult.exists) {
      // File exists at HEAD - reset to HEAD version in index
      await git.resetIndex({
        fs: this.fs,
        dir,
        filepath,
      });
    } else {
      // File is new (not in HEAD) - remove from index entirely
      await git.remove({
        fs: this.fs,
        dir,
        filepath,
      });
    }
  }

  /**
   * Stage selected hunks/lines for a file
   */
  async stageHunks(options: StageHunksOptions): Promise<void> {
    const { dir, filepath, hunks } = options;
    const indexResult = await this.readFromIndex(dir, filepath);
    const oldResult = indexResult.exists
      ? indexResult
      : await this.readFromRef(dir, filepath, "HEAD");
    const newResult = await this.readFromWorkingTree(dir, filepath);

    const binary = isBinary(oldResult.raw ?? oldResult.content) ||
      isBinary(newResult.raw ?? newResult.content);
    if (binary) {
      throw new Error("Partial staging is not supported for binary files.");
    }

    const diffHunks = generateDiff(oldResult.content, newResult.content);
    if (diffHunks.length === 0) return;

    for (const selection of hunks) {
      if (selection.hunkIndex < 0 || selection.hunkIndex >= diffHunks.length) {
        throw new Error(`Invalid hunk index: ${selection.hunkIndex}`);
      }
    }

    const nextContent = applyHunks(oldResult.content, diffHunks, hunks);

    if (!newResult.exists && nextContent === "" && oldResult.exists) {
      await git.updateIndex({
        fs: this.fs,
        dir,
        filepath,
        remove: true,
        force: true,
      });
      return;
    }

    const oid = await git.writeBlob({
      fs: this.fs,
      dir,
      blob: new TextEncoder().encode(nextContent),
    });

    await git.updateIndex({
      fs: this.fs,
      dir,
      filepath,
      oid,
      add: true,
    });
  }

  /**
   * Unstage selected hunks/lines for a file
   */
  async unstageHunks(options: StageHunksOptions): Promise<void> {
    const { dir, filepath, hunks } = options;
    const headResult = await this.readFromRef(dir, filepath, "HEAD");
    const indexResult = await this.readFromIndex(dir, filepath);

    if (!indexResult.exists) return;

    const binary = isBinary(headResult.raw ?? headResult.content) ||
      isBinary(indexResult.raw ?? indexResult.content);
    if (binary) {
      throw new Error("Partial unstaging is not supported for binary files.");
    }

    const diffHunks = generateDiff(headResult.content, indexResult.content);
    if (diffHunks.length === 0) return;

    for (const selection of hunks) {
      if (selection.hunkIndex < 0 || selection.hunkIndex >= diffHunks.length) {
        throw new Error(`Invalid hunk index: ${selection.hunkIndex}`);
      }
    }

    const selectionsMap = normalizeHunkSelections(hunks);
    const keepSelections: HunkSelection[] = [];

    diffHunks.forEach((hunk, hunkIndex) => {
      const selected = selectionsMap.get(hunkIndex);
      if (selected === undefined) {
        keepSelections.push({ hunkIndex });
        return;
      }
      if (selected === null) {
        return;
      }
      const changeIndices = hunk.lines
        .map((line, idx) => (line.type === "context" ? null : idx))
        .filter((idx): idx is number => idx !== null);
      const keep = changeIndices.filter((idx) => !selected.has(idx));
      if (keep.length > 0) {
        keepSelections.push({ hunkIndex, lineIndices: keep });
      }
    });

    const nextContent = applyHunks(headResult.content, diffHunks, keepSelections);

    if (!headResult.exists && nextContent === "" && indexResult.exists) {
      await git.updateIndex({
        fs: this.fs,
        dir,
        filepath,
        remove: true,
        force: true,
      });
      return;
    }

    const oid = await git.writeBlob({
      fs: this.fs,
      dir,
      blob: new TextEncoder().encode(nextContent),
    });

    await git.updateIndex({
      fs: this.fs,
      dir,
      filepath,
      oid,
      add: true,
    });
  }

  /**
   * Discard working tree changes (git checkout -- <file>)
   * For files with staged changes: restores from index (staged version)
   * For files without staged changes: restores from HEAD
   * For untracked/new files: deletes the file and unstages if staged
   */
  async discardChanges(dir: string, filepath: string): Promise<void> {
    // Check if file exists in index (staged)
    const indexResult = await this.readFromIndex(dir, filepath);

    if (indexResult.exists) {
      // File exists in index - restore working tree to match index
      // This preserves staged changes while discarding unstaged changes
      // Use raw bytes when available to preserve binary files correctly
      await this.fsPromises.writeFile(`${dir}/${filepath}`, indexResult.raw ?? indexResult.content);
    } else {
      // File not in index - check if it exists in HEAD
      const headResult = await this.readFromRef(dir, filepath, "HEAD");

      if (headResult.exists) {
        // File exists in HEAD but not in index - restore from HEAD
        await git.checkout({
          fs: this.fs,
          dir,
          filepaths: [filepath],
          force: true,
        });
      } else {
        // File is completely untracked (not in HEAD or index)
        // Just delete the working tree file
        try {
          await this.fsPromises.unlink(`${dir}/${filepath}`);
        } catch (unlinkErr) {
          // Only ignore ENOENT (file doesn't exist), re-throw other errors
          const err = unlinkErr as NodeJS.ErrnoException;
          if (err.code !== "ENOENT") {
            throw unlinkErr;
          }
        }
      }
    }
  }

  /**
   * List conflicted files with parsed markers
   */
  async getConflicts(dir: string): Promise<ConflictInfo[]> {
    const matrix = await git.statusMatrix({ fs: this.fs, dir });
    const candidates = new Set<string>();

    for (const [filepath, head, workdir, stage] of matrix) {
      if (head === 1 && workdir === 1 && stage === 1) continue;
      candidates.add(filepath);
    }

    const conflicts: ConflictInfo[] = [];
    for (const filepath of candidates) {
      const result = await this.readFromWorkingTree(dir, filepath);
      if (!result.exists) continue;
      if (!result.content.includes("<<<<<<<")) continue;

      const parsed = parseConflictMarkers(result.content);
      if (parsed.markers.length === 0) continue;
      conflicts.push({
        path: filepath,
        original: result.content,
        base: parsed.base,
        ours: parsed.ours,
        theirs: parsed.theirs,
        markers: parsed.markers,
      });
    }

    return conflicts;
  }

  /**
   * Resolve a conflict by writing the resolved content and staging it
   */
  async resolveConflict(dir: string, resolution: ConflictResolution): Promise<void> {
    await this.fsPromises.writeFile(`${dir}/${resolution.path}`, resolution.content);
    await git.add({
      fs: this.fs,
      dir,
      filepath: resolution.path,
    });
  }

  /**
   * Get additions/deletions count for status display
   */
  async getFileStats(
    dir: string,
    filepath: string,
    staged: boolean
  ): Promise<{ additions: number; deletions: number }> {
    const diff = staged
      ? await this.getStagedDiff(dir, filepath)
      : await this.getWorkingDiff(dir, filepath);

    let additions = 0;
    let deletions = 0;

    for (const hunk of diff.hunks) {
      for (const line of hunk.lines) {
        if (line.type === "add") additions++;
        if (line.type === "delete") deletions++;
      }
    }

    return { additions, deletions };
  }

  /**
   * Create a stash using isomorphic-git.
   * Note: isomorphic-git only stashes tracked files (untracked files are not stashed).
   */
  async stash(
    dir: string,
    options?: { message?: string; includeUntracked?: boolean }
  ): Promise<void> {
    // Note: isomorphic-git's stash doesn't support includeUntracked
    // It only stashes working directory and index changes for tracked files
    await git.stash({
      fs: this.fs,
      dir,
      op: "push",
      message: options?.message,
    });
  }

  /**
   * List stashes using isomorphic-git.
   */
  async stashList(dir: string): Promise<StashEntry[]> {
    const result = await git.stash({
      fs: this.fs,
      dir,
      op: "list",
    });

    // isomorphic-git returns an array of stash entries
    // Each entry has: message, oid (commit hash)
    const entries = result as Array<{ message: string; oid: string }> | undefined;
    if (!entries || !Array.isArray(entries)) {
      return [];
    }

    return entries.map((entry, index) => ({
      index,
      ref: `stash@{${index}}`,
      message: entry.message ?? "",
      timestamp: undefined, // isomorphic-git doesn't provide timestamp directly
    }));
  }

  /**
   * Apply a stash without dropping it.
   */
  async stashApply(dir: string, index: number = 0): Promise<void> {
    await git.stash({
      fs: this.fs,
      dir,
      op: "apply",
      refIdx: index,
    });
  }

  /**
   * Pop a stash (apply + drop).
   */
  async stashPop(dir: string, index: number = 0): Promise<void> {
    await git.stash({
      fs: this.fs,
      dir,
      op: "pop",
      refIdx: index,
    });
  }

  /**
   * Drop a stash entry.
   */
  async stashDrop(dir: string, index: number = 0): Promise<void> {
    await git.stash({
      fs: this.fs,
      dir,
      op: "drop",
      refIdx: index,
    });
  }

  /**
   * Get list of files changed in a specific commit
   */
  async getCommitFiles(
    dir: string,
    sha: string
  ): Promise<Array<{ path: string; status: "added" | "modified" | "deleted" }>> {
    try {
      // Get the commit's tree
      const commitInfo = await git.readCommit({
        fs: this.fs,
        dir,
        oid: sha,
      });

      // Get parent commit (if exists)
      const parentOid = commitInfo.commit.parent[0];

      // Walk both trees and compare
      const files: Array<{ path: string; status: "added" | "modified" | "deleted" }> = [];

      if (parentOid) {
        // Compare with parent commit
        await git.walk({
          fs: this.fs,
          dir,
          trees: [git.TREE({ ref: parentOid }), git.TREE({ ref: sha })],
          map: async (filepath, [parentEntry, currentEntry]) => {
            if (filepath === ".") return;

            const parentBlobOid = parentEntry ? await parentEntry.oid() : null;
            const currentBlobOid = currentEntry ? await currentEntry.oid() : null;
            const parentType = parentEntry ? await parentEntry.type() : null;
            const currentType = currentEntry ? await currentEntry.type() : null;

            // Skip directories
            if (parentType === "tree" || currentType === "tree") return;

            if (!parentBlobOid && currentBlobOid) {
              files.push({ path: filepath, status: "added" });
            } else if (parentBlobOid && !currentBlobOid) {
              files.push({ path: filepath, status: "deleted" });
            } else if (parentBlobOid && currentBlobOid && parentBlobOid !== currentBlobOid) {
              files.push({ path: filepath, status: "modified" });
            }

            return;
          },
        });
      } else {
        // Initial commit - all files are added
        await git.walk({
          fs: this.fs,
          dir,
          trees: [git.TREE({ ref: sha })],
          map: async (filepath, [entry]) => {
            if (filepath === ".") return;

            const entryType = entry ? await entry.type() : null;
            if (entryType === "tree") return;

            if (entry) {
              files.push({ path: filepath, status: "added" });
            }

            return;
          },
        });
      }

      return files;
    } catch {
      return [];
    }
  }

  /**
   * Get diff for a file in a commit compared to its parent
   */
  async getCommitDiff(dir: string, sha: string, filepath: string): Promise<FileDiff> {
    try {
      const commitOid = isFullOid(sha)
        ? sha
        : await git.resolveRef({
            fs: this.fs,
            dir,
            ref: sha,
          });

      const commitInfo = await git.readCommit({
        fs: this.fs,
        dir,
        oid: commitOid,
      });

      const parentOid = commitInfo.commit.parent[0] ?? null;

      // Commit diff: compare commit content against parent (or empty for initial commit)
      const newResult = await this.readFromRef(dir, filepath, commitOid);
      const oldResult = parentOid
        ? await this.readFromRef(dir, filepath, parentOid)
        : { content: "", exists: false };

      return this.buildDiff(filepath, oldResult, newResult);
    } catch {
      return {
        path: filepath,
        oldContent: "",
        newContent: "",
        hunks: [],
        binary: false,
      };
    }
  }
}
