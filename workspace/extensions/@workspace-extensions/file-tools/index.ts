import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import * as fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const { rgPath } = require("@vscode/ripgrep") as { rgPath: string };

const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_BYTES = 128 * 1024;
const DEFAULT_READ_MAX_BYTES = 50 * 1024;
const DEFAULT_READ_MAX_LINES = 2000;
const GREP_MAX_LINE_LENGTH = 500;

interface ExtensionContextLike {
  workspace: {
    getInfo(): Promise<{ path: string; contextsPath: string }>;
  };
  fs: {
    realpath(path: string): Promise<string>;
  };
  log: {
    info(message: string): void;
  };
  health?: {
    healthy(status: { summary: string }): void;
    degraded(status: { summary: string; reasons?: string[] }): void;
  };
}

interface GrepRequest {
  pattern: string;
  path?: string;
  cwd?: string;
  glob?: string;
  ignoreCase?: boolean;
  literal?: boolean;
  context?: number;
  limit?: number;
}

interface FindRequest {
  pattern: string;
  path?: string;
  cwd?: string;
  limit?: number;
}

interface ReadRequest {
  path: string;
  cwd?: string;
  offset?: number;
  limit?: number;
}

interface TruncationResult {
  truncated: boolean;
  originalBytes?: number;
  returnedBytes?: number;
  content?: string;
  truncatedBy?: "lines" | "bytes" | null;
  totalLines?: number;
  totalBytes?: number;
  outputLines?: number;
  outputBytes?: number;
  lastLinePartial?: boolean;
  firstLineExceedsLimit?: boolean;
  maxLines?: number;
  maxBytes?: number;
}

interface GrepTruncationResult extends TruncationResult {
  originalBytes: number;
  returnedBytes: number;
  content: string;
}

interface GrepDetails {
  truncation?: GrepTruncationResult;
  matchLimitReached?: number;
  linesTruncated?: boolean;
  engine: "ripgrep";
}

interface FindDetails {
  truncation?: GrepTruncationResult;
  resultLimitReached?: number;
  engine: "ripgrep";
}

interface ReadDetails {
  truncation?: TruncationResult;
  path: string;
  size?: number;
  engine: "node-file";
}

function resolveWithin(root: string, input: string): string {
  const resolved = path.resolve(root, input);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes search root: ${input}`);
  }
  return resolved;
}

async function realpathWithin(root: string, input: string): Promise<string> {
  const realRoot = await fs.realpath(root);
  const realInput = await fs.realpath(input);
  const rel = path.relative(realRoot, realInput);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`Path escapes search root: ${input}`);
  }
  return realInput;
}

function resolveVirtualPath(cwd: string | undefined, input: string | undefined): string {
  const base = cwd && cwd.startsWith("/") ? cwd : `/${cwd ?? ""}`;
  const requested = input ?? ".";
  const joined = requested.startsWith("/")
    ? path.posix.normalize(requested)
    : path.posix.normalize(path.posix.join(base, requested));
  return joined === "." ? "/" : joined.startsWith("/") ? joined : `/${joined}`;
}

async function resolveSearchPath(ctx: ExtensionContextLike, req: {
  path?: string;
  cwd?: string;
}): Promise<{
  root: string;
  searchPath: string;
  isDirectory: boolean;
}> {
  const root = await ctx.fs.realpath("/");
  if (root === path.parse(root).root) {
    throw new Error("file-tools requires a scoped extension invocation context");
  }
  const virtualPath = resolveVirtualPath(req.cwd, req.path);
  const searchPath = resolveWithin(root, `.${virtualPath}`);
  let stat;
  try {
    stat = await fs.stat(searchPath);
  } catch {
    throw new Error(`Path not found: ${virtualPath}`);
  }
  const realSearchPath = await realpathWithin(root, searchPath);
  return { root, searchPath: realSearchPath, isDirectory: stat.isDirectory() };
}

function truncateLine(line: string): { text: string; wasTruncated: boolean } {
  if (line.length <= GREP_MAX_LINE_LENGTH) return { text: line, wasTruncated: false };
  return { text: `${line.slice(0, GREP_MAX_LINE_LENGTH)}...`, wasTruncated: true };
}

function truncateGrepOutput(content: string): GrepTruncationResult {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= DEFAULT_MAX_BYTES) {
    return { truncated: false, originalBytes: bytes, returnedBytes: bytes, content };
  }
  let returned = content;
  while (Buffer.byteLength(returned, "utf8") > DEFAULT_MAX_BYTES) {
    returned = returned.slice(0, Math.max(0, returned.length - 1024));
  }
  return {
    truncated: true,
    originalBytes: bytes,
    returnedBytes: Buffer.byteLength(returned, "utf8"),
    maxBytes: DEFAULT_MAX_BYTES,
    content: returned,
  };
}

function makeReadTruncation(params: {
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  firstLineExceedsLimit?: boolean;
}): TruncationResult {
  return {
    truncated: params.truncated,
    truncatedBy: params.truncatedBy,
    totalLines: params.totalLines,
    totalBytes: params.totalBytes,
    outputLines: params.outputLines,
    outputBytes: params.outputBytes,
    lastLinePartial: false,
    firstLineExceedsLimit: params.firstLineExceedsLimit ?? false,
    maxLines: DEFAULT_READ_MAX_LINES,
    maxBytes: DEFAULT_READ_MAX_BYTES,
  };
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${Math.round(bytes / (1024 * 1024))}MB`;
}

function toPosixPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function relativeTo(root: string, filePath: string): string {
  return toPosixPath(path.relative(root, filePath));
}

function isLikelyImageHeader(header: Buffer): boolean {
  if (header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return true;
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return true;
  if (header.length >= 6 && (header.subarray(0, 6).toString("ascii") === "GIF87a" || header.subarray(0, 6).toString("ascii") === "GIF89a")) {
    return true;
  }
  if (header.length >= 12 && header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP") {
    return true;
  }
  return false;
}

function codedError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("file-tools extension activating");
  ctx.health?.healthy({ summary: "File tools extension activated" });

  return {
    async grep(raw: GrepRequest) {
      if (!raw || typeof raw.pattern !== "string") {
        throw new Error("file-tools.grep requires a pattern");
      }

      const { searchPath, isDirectory } = await resolveSearchPath(ctx, raw);
      const contextValue = raw.context && raw.context > 0 ? raw.context : 0;
      const effectiveLimit = Math.max(1, raw.limit ?? DEFAULT_LIMIT);

      const formatPath = (filePath: string): string => {
        if (isDirectory) {
          const relative = path.relative(searchPath, filePath);
          if (relative && !relative.startsWith("..")) return relative.replace(/\\/g, "/");
        }
        return path.basename(filePath);
      };

      const fileCache = new Map<string, string[]>();
      const getFileLines = async (filePath: string): Promise<string[]> => {
        let lines = fileCache.get(filePath);
        if (!lines) {
          try {
            const content = await fs.readFile(filePath, "utf8");
            lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
          } catch {
            lines = [];
          }
          fileCache.set(filePath, lines);
        }
        return lines;
      };

      const args = ["--json", "--line-number", "--color=never", "--hidden"];
      if (raw.ignoreCase) args.push("--ignore-case");
      if (raw.literal) args.push("--fixed-strings");
      if (raw.glob) args.push("--glob", raw.glob);
      args.push(raw.pattern, searchPath);

      return await new Promise((resolve, reject) => {
        const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
        const rl = createInterface({ input: child.stdout });
        let stderr = "";
        let matchCount = 0;
        let matchLimitReached = false;
        let killedDueToLimit = false;
        let linesTruncated = false;
        const matches: Array<{ filePath: string; lineNumber: number }> = [];

        const stopChild = (dueToLimit = false) => {
          if (!child.killed) {
            killedDueToLimit = dueToLimit;
            child.kill();
          }
        };

        child.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        rl.on("line", (line) => {
          if (!line.trim() || matchCount >= effectiveLimit) return;
          let event: unknown;
          try {
            event = JSON.parse(line);
          } catch {
            return;
          }
          const record = event as {
            type?: string;
            data?: { path?: { text?: string }; line_number?: number };
          };
          if (record.type !== "match") return;
          matchCount++;
          const filePath = record.data?.path?.text;
          const lineNumber = record.data?.line_number;
          if (filePath && typeof lineNumber === "number") {
            matches.push({ filePath, lineNumber });
          }
          if (matchCount >= effectiveLimit) {
            matchLimitReached = true;
            stopChild(true);
          }
        });

        child.on("error", (err) => {
          rl.close();
          reject(new Error(`Failed to run ripgrep: ${err.message}`));
        });

        child.on("close", async (code) => {
          rl.close();
          if (!killedDueToLimit && code !== 0 && code !== 1) {
            reject(new Error(stderr.trim() || `ripgrep exited with code ${code}`));
            return;
          }
          if (matchCount === 0) {
            resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined });
            return;
          }

          const outputLines: string[] = [];
          for (const match of matches) {
            const relativePath = formatPath(match.filePath);
            const lines = await getFileLines(match.filePath);
            if (!lines.length) {
              outputLines.push(`${relativePath}:${match.lineNumber}: (unable to read file)`);
              continue;
            }
            const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber;
            const end = contextValue > 0 ? Math.min(lines.length, match.lineNumber + contextValue) : match.lineNumber;
            for (let current = start; current <= end; current++) {
              const sanitized = (lines[current - 1] ?? "").replace(/\r/g, "");
              const { text, wasTruncated } = truncateLine(sanitized);
              if (wasTruncated) linesTruncated = true;
              outputLines.push(
                current === match.lineNumber
                  ? `${relativePath}:${current}: ${text}`
                  : `${relativePath}-${current}- ${text}`,
              );
            }
          }

          const truncation = truncateGrepOutput(outputLines.join("\n"));
          let output = truncation.content;
          const details: GrepDetails = { engine: "ripgrep" };
          const notices: string[] = [];
          if (matchLimitReached) {
            notices.push(
              `${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
            );
            details.matchLimitReached = effectiveLimit;
          }
          if (truncation.truncated) {
            notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
            details.truncation = truncation;
          }
          if (linesTruncated) {
            notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
            details.linesTruncated = true;
          }
          if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
          resolve({
            content: [{ type: "text", text: output }],
            details: Object.keys(details).length > 0 ? details : undefined,
          });
        });
      });
    },

    async find(raw: FindRequest) {
      if (!raw || typeof raw.pattern !== "string") {
        throw new Error("file-tools.find requires a pattern");
      }

      const { searchPath } = await resolveSearchPath(ctx, raw);
      const effectiveLimit = Math.max(1, raw.limit ?? 1000);
      const args = ["--files", "--hidden", "--color=never", "--glob", raw.pattern, searchPath];

      return await new Promise((resolve, reject) => {
        const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
        const rl = createInterface({ input: child.stdout });
        const matches: string[] = [];
        let stderr = "";
        let killedDueToLimit = false;

        const stopChild = () => {
          if (!child.killed) {
            killedDueToLimit = true;
            child.kill();
          }
        };

        child.stderr?.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        rl.on("line", (line) => {
          if (!line.trim() || matches.length >= effectiveLimit) return;
          matches.push(relativeTo(searchPath, line.replace(/\r$/, "")));
          if (matches.length >= effectiveLimit) stopChild();
        });

        child.on("error", (err) => {
          rl.close();
          reject(new Error(`Failed to run ripgrep --files: ${err.message}`));
        });

        child.on("close", (code) => {
          rl.close();
          if (!killedDueToLimit && code !== 0 && code !== 1) {
            reject(new Error(stderr.trim() || `ripgrep --files exited with code ${code}`));
            return;
          }
          if (matches.length === 0) {
            resolve({ content: [{ type: "text", text: "No files found matching pattern" }], details: undefined });
            return;
          }

          const truncation = truncateGrepOutput(matches.join("\n"));
          let output = truncation.content;
          const details: FindDetails = { engine: "ripgrep" };
          const notices: string[] = [];
          if (matches.length >= effectiveLimit) {
            notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
            details.resultLimitReached = effectiveLimit;
          }
          if (truncation.truncated) {
            notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
            details.truncation = truncation;
          }
          if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
          resolve({
            content: [{ type: "text", text: output }],
            details,
          });
        });
      });
    },

    async read(raw: ReadRequest) {
      if (!raw || typeof raw.path !== "string") {
        throw new Error("file-tools.read requires a path");
      }

      const { searchPath } = await resolveSearchPath(ctx, { ...raw, path: raw.path });
      const stat = await fs.stat(searchPath);
      if (!stat.isFile()) throw new Error(`Not a file: ${raw.path}`);

      const header = await fs.open(searchPath, "r")
        .then(async (handle) => {
          try {
            const buffer = Buffer.alloc(16);
            const result = await handle.read(buffer, 0, buffer.length, 0);
            return buffer.subarray(0, result.bytesRead);
          } finally {
            await handle.close();
          }
        });
      if (isLikelyImageHeader(header)) {
        throw codedError("EIMAGE", "Image reads are handled by the image service path");
      }

      const startLine = raw.offset ? Math.max(1, Math.trunc(raw.offset)) : 1;
      const requestedLimit = raw.limit !== undefined ? Math.max(0, Math.trunc(raw.limit)) : undefined;
      const stream = createReadStream(searchPath, { encoding: "utf8" });
      const rl = createInterface({ input: stream, crlfDelay: Infinity });
      const outputLines: string[] = [];
      let lineNumber = 0;
      let outputBytes = 0;
      let truncatedBy: "lines" | "bytes" | null = null;
      let firstLineExceedsLimit = false;
      let hasMore = false;

      try {
        for await (const line of rl) {
          lineNumber++;
          if (lineNumber < startLine) continue;

          const selectedIndex = lineNumber - startLine;
          if (requestedLimit !== undefined && selectedIndex >= requestedLimit) {
            hasMore = true;
            break;
          }
          if (outputLines.length >= DEFAULT_READ_MAX_LINES) {
            truncatedBy = "lines";
            hasMore = true;
            break;
          }

          const lineBytes = Buffer.byteLength(line, "utf8") + (outputLines.length > 0 ? 1 : 0);
          if (outputLines.length === 0 && lineBytes > DEFAULT_READ_MAX_BYTES) {
            truncatedBy = "bytes";
            firstLineExceedsLimit = true;
            hasMore = true;
            break;
          }
          if (outputBytes + lineBytes > DEFAULT_READ_MAX_BYTES) {
            truncatedBy = "bytes";
            hasMore = true;
            break;
          }
          outputLines.push(line);
          outputBytes += lineBytes;
        }
      } finally {
        rl.close();
        stream.destroy();
      }

      if (lineNumber < startLine && outputLines.length === 0) {
        throw new Error(`Offset ${raw.offset} is beyond end of file (${lineNumber} lines total)`);
      }

      const truncated = truncatedBy !== null;
      const truncation = makeReadTruncation({
        truncated,
        truncatedBy,
        totalLines: lineNumber,
        totalBytes: stat.size,
        outputLines: outputLines.length,
        outputBytes,
        firstLineExceedsLimit,
      });

      let text: string;
      if (firstLineExceedsLimit) {
        const firstLineSize = formatSize(stat.size);
        text = `[Line ${startLine} exceeds ${formatSize(DEFAULT_READ_MAX_BYTES)} limit. Use offset=${startLine + 1} to skip past it.]`;
        truncation.totalBytes = stat.size;
        truncation.outputBytes = 0;
        if (firstLineSize) {
          // Keep the same compact notice shape as the harness fallback.
        }
      } else {
        text = outputLines.join("\n");
        if (truncated) {
          const endLine = startLine + outputLines.length - 1;
          const nextOffset = Math.max(startLine + 1, endLine + 1);
          const reason = truncatedBy === "lines"
            ? `${DEFAULT_READ_MAX_LINES} line limit`
            : `${formatSize(DEFAULT_READ_MAX_BYTES)} limit`;
          text += `\n\n[Showing lines ${startLine}-${endLine} (${reason}). Use offset=${nextOffset} to continue.]`;
        } else if (requestedLimit !== undefined && hasMore) {
          const nextOffset = startLine + outputLines.length;
          text += `\n\n[More lines in file. Use offset=${nextOffset} to continue.]`;
        }
      }

      const details: ReadDetails = {
        path: raw.path,
        size: stat.size,
        engine: "node-file",
        ...(truncated ? { truncation } : {}),
      };

      return {
        content: [{ type: "text", text }],
        details,
      };
    },
  };
}
