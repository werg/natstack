/**
 * Grep tool — workerd-native rewrite of pi-coding-agent's
 * `dist/core/tools/grep.js`.
 *
 * The upstream tool spawns ripgrep via `child_process.spawn`. workerd has
 * neither `child_process` nor any native binary, so we walk the directory
 * tree through `RuntimeFs` and apply the regex ourselves. The schema,
 * details type, and output formatting match the upstream tool so chat-UI
 * renderers don't have to special-case the workerd port.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";
import path from "node:path";
import { Buffer } from "node:buffer";
import type { RuntimeFs, Dirent } from "./runtime-fs.js";
import { resolveToCwd } from "./path-utils.js";
import {
  DEFAULT_MAX_BYTES,
  formatSize,
  GREP_MAX_LINE_LENGTH,
  truncateHead,
  truncateLine,
  type TruncationResult,
} from "./truncate.js";

const grepSchema = Type.Object({
  pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
  path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
  glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
  ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
  literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
  context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export type GrepToolInput = Static<typeof grepSchema>;

export interface GrepToolDetails {
  truncation?: TruncationResult;
  matchLimitReached?: number;
  linesTruncated?: boolean;
}

const DEFAULT_LIMIT = 100;

// Directories we never want to descend into. Mirrors fd/rg's defaults plus
// the JS toolchain's heavy hitters; the workerd port has no .gitignore
// support so we hard-code the obvious offenders.
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".svelte-kit",
  ".next",
  "dist",
  "build",
  ".cache",
  ".turbo",
]);

export function createGrepTool(
  cwd: string,
  fs: RuntimeFs,
): AgentTool<typeof grepSchema, GrepToolDetails | undefined> {
  return {
    name: "grep",
    label: "grep",
    description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
    parameters: grepSchema,
    execute: async (
      _toolCallId,
      { pattern, path: searchDir, glob, ignoreCase, literal, context, limit },
      signal,
    ) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const searchPath = resolveToCwd(searchDir || ".", cwd);
      const contextValue = context && context > 0 ? context : 0;
      const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);

      // Stat the entry point so we know whether to walk a tree or open a file.
      let isDirectory: boolean;
      try {
        const stat = await fs.stat(searchPath);
        isDirectory = stat.isDirectory();
      } catch {
        throw new Error(`Path not found: ${searchPath}`);
      }

      const regex = buildRegex(pattern, { literal: !!literal, ignoreCase: !!ignoreCase });
      const globRegex = glob ? globToRegex(glob) : null;

      // Collect candidate files
      const files: string[] = [];
      if (isDirectory) {
        await walk(fs, searchPath, files, signal);
      } else {
        files.push(searchPath);
      }

      // Filter by glob (relative to searchPath when walking a tree, basename otherwise).
      const filtered = globRegex
        ? files.filter((f) => {
            const rel = isDirectory ? path.relative(searchPath, f) : path.basename(f);
            return globRegex.test(rel.replace(/\\/g, "/"));
          })
        : files;

      const formatPath = (filePath: string): string => {
        if (isDirectory) {
          const relative = path.relative(searchPath, filePath);
          if (relative && !relative.startsWith("..")) {
            return relative.replace(/\\/g, "/");
          }
        }
        return path.basename(filePath);
      };

      let matchCount = 0;
      let matchLimitReached = false;
      let linesTruncated = false;
      const outputLines: string[] = [];

      for (const filePath of filtered) {
        if (signal?.aborted) {
          throw new Error("Operation aborted");
        }
        if (matchCount >= effectiveLimit) {
          matchLimitReached = true;
          break;
        }
        let raw: string | Buffer;
        try {
          raw = await fs.readFile(filePath);
        } catch {
          continue;
        }
        const text = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
        const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
        const relativePath = formatPath(filePath);
        for (let i = 0; i < lines.length; i++) {
          if (matchCount >= effectiveLimit) {
            matchLimitReached = true;
            break;
          }
          // Reset regex state for each line (relevant when /g is set elsewhere).
          regex.lastIndex = 0;
          if (regex.test(lines[i]!)) {
            matchCount++;
            const lineNumber = i + 1;
            const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
            const end =
              contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
            for (let cur = start; cur <= end; cur++) {
              const lineText = (lines[cur - 1] ?? "").replace(/\r/g, "");
              const { text: truncatedText, wasTruncated } = truncateLine(lineText);
              if (wasTruncated) linesTruncated = true;
              if (cur === lineNumber) {
                outputLines.push(`${relativePath}:${cur}: ${truncatedText}`);
              } else {
                outputLines.push(`${relativePath}-${cur}- ${truncatedText}`);
              }
            }
          }
        }
      }

      if (matchCount === 0) {
        return {
          content: [{ type: "text", text: "No matches found" }],
          details: undefined,
        } as { content: (TextContent | ImageContent)[]; details: undefined };
      }

      const rawOutput = outputLines.join("\n");
      const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
      let output = truncation.content;
      const details: GrepToolDetails = {};
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
        notices.push(
          `Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
        );
        details.linesTruncated = true;
      }
      if (notices.length > 0) {
        output += `\n\n[${notices.join(". ")}]`;
      }

      return {
        content: [{ type: "text", text: output }],
        details: Object.keys(details).length > 0 ? details : undefined,
      };
    },
  };
}

/** Build a JS regex from the user's pattern, honouring `literal` / `ignoreCase`. */
function buildRegex(
  pattern: string,
  { literal, ignoreCase }: { literal: boolean; ignoreCase: boolean },
): RegExp {
  const source = literal ? escapeRegex(pattern) : pattern;
  const flags = ignoreCase ? "i" : "";
  return new RegExp(source, flags);
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translate a glob pattern (`*.ts`, `**\/*.spec.ts`) into a regex anchored
 * to the start and end of the test string. Supports `*`, `**`, and `?`.
 */
export function globToRegex(glob: string): RegExp {
  let re = "^";
  let i = 0;
  while (i < glob.length) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // ** matches across path separators
        re += ".*";
        i += 2;
        if (glob[i] === "/") i++;
      } else {
        re += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      re += "[^/]";
      i++;
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
      i++;
    } else {
      re += c;
      i++;
    }
  }
  re += "$";
  return new RegExp(re);
}

/** Recursive directory walk that skips heavy directories and respects abort. */
async function walk(
  fs: RuntimeFs,
  dir: string,
  out: string[],
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal?.aborted) return;
  let entries: Dirent[];
  try {
    entries = (await fs.readdir(dir, { withFileTypes: true })) as Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    if (signal?.aborted) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(fs, full, out, signal);
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
}
