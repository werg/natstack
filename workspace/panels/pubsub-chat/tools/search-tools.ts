/**
 * Search tools for pubsub RPC.
 *
 * Implements: glob, grep
 * These match Claude Code's Glob and Grep tools API.
 *
 * Uses picomatch + shimmed fs for browser compatibility.
 */

import * as fs from "fs";
import * as path from "path";
import picomatch from "picomatch";
import type { MethodDefinition } from "@natstack/agentic-messaging";
import { resolvePath } from "./utils";
import {
  GlobArgsSchema,
  GrepArgsSchema,
  FILE_TYPE_MAPPINGS,
  type GlobArgs,
  type GrepArgs,
} from "@natstack/agentic-messaging";

const MAX_RESULTS = 1000;

// Default ignore patterns for file traversal
const DEFAULT_IGNORE_PATTERNS = ["**/node_modules/**", "**/.git/**"];

interface GlobResult {
  path: string;
  mtimeMs?: number;
}

/**
 * Walk a directory tree and find files matching a pattern.
 * Uses shimmed fs.readdir({ withFileTypes: true }) for browser compatibility.
 */
async function walkDirectory(
  dir: string,
  relative: string,
  matcher: (path: string) => boolean,
  ignoreMatcher: ((path: string) => boolean) | null,
  options: { stats?: boolean },
  results: GlobResult[]
): Promise<void> {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    // Directory not accessible, skip
    return;
  }

  for (const entry of entries) {
    const relPath = relative ? `${relative}/${entry.name}` : entry.name;
    const fullPath = path.join(dir, entry.name);

    // Skip ignored paths
    if (ignoreMatcher?.(relPath)) continue;

    if (entry.isDirectory()) {
      // Recursively walk subdirectories
      await walkDirectory(fullPath, relPath, matcher, ignoreMatcher, options, results);
    } else if (matcher(relPath)) {
      const result: GlobResult = { path: relPath };
      if (options.stats) {
        try {
          const stats = await fs.promises.stat(fullPath);
          result.mtimeMs = stats.mtimeMs;
        } catch {
          // If we can't stat, still include the file
        }
      }
      results.push(result);
    }
  }
}

/**
 * glob - Find files by pattern
 * Browser-compatible implementation using picomatch + shimmed fs.
 */
export async function glob(args: GlobArgs, workspaceRoot?: string): Promise<string> {
  const { pattern } = args;
  const searchPath = args.path ?? workspaceRoot ?? process.cwd();
  const absolutePath = resolvePath(searchPath, workspaceRoot);

  try {
    const matcher = picomatch(pattern);
    const ignoreMatcher = picomatch(DEFAULT_IGNORE_PATTERNS);

    const results: GlobResult[] = [];
    await walkDirectory(absolutePath, "", matcher, ignoreMatcher, { stats: true }, results);

    if (results.length === 0) {
      return "";
    }

    // Sort by modification time (newest first)
    const sorted = results
      .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))
      .slice(0, MAX_RESULTS);

    // Return relative paths, one per line
    return sorted.map((entry) => entry.path).join("\n");
  } catch (err) {
    throw new Error(`Glob failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Get glob patterns for a file type
 */
function getGlobsForType(type: string): string[] {
  const patterns = FILE_TYPE_MAPPINGS[type.toLowerCase()];
  if (!patterns) {
    // Fallback: treat as extension
    return [`*.${type}`];
  }
  return patterns;
}

/**
 * Find files matching patterns in a directory.
 * Uses walkDirectory with picomatch for browser compatibility.
 */
async function findFiles(
  absolutePath: string,
  filePatterns: string[],
  ignore: string[]
): Promise<string[]> {
  // Check if path is a file
  let stats;
  try {
    stats = await fs.promises.stat(absolutePath);
  } catch {
    return [];
  }

  if (stats.isFile()) {
    return [absolutePath];
  }

  // Create matcher for file patterns (match any pattern)
  const fileMatcher = picomatch(filePatterns);
  const ignoreMatcher = picomatch(ignore);

  const results: GlobResult[] = [];
  await walkDirectory(absolutePath, "", fileMatcher, ignoreMatcher, { stats: false }, results);

  // Return absolute paths
  return results.map((r) => path.join(absolutePath, r.path));
}

/**
 * grep - Search file contents with regex
 */
export async function grep(args: GrepArgs, workspaceRoot?: string): Promise<string> {
  const {
    pattern,
    output_mode: outputMode = "files_with_matches",
    glob: globPattern,
    type,
    "-i": caseInsensitive,
    "-n": showLineNumbers = true,
    "-A": linesAfter,
    "-B": linesBefore,
    "-C": linesContext,
    head_limit: headLimit,
    offset = 0,
    multiline,
  } = args;
  const searchPath = args.path ?? workspaceRoot ?? process.cwd();
  const absolutePath = resolvePath(searchPath, workspaceRoot);

  // Build file patterns
  let filePatterns: string[] = ["**/*"];

  if (globPattern) {
    filePatterns = [globPattern];
  } else if (type) {
    filePatterns = getGlobsForType(type);
  }

  // Create regex
  let flags = "g";
  if (caseInsensitive) flags += "i";
  if (multiline) flags += "ms";

  let regex: RegExp;
  try {
    regex = new RegExp(pattern, flags);
  } catch (err) {
    throw new Error(`Invalid regex pattern: ${err instanceof Error ? err.message : String(err)}`);
  }

  // Calculate context lines
  const contextBefore = linesContext ?? linesBefore ?? 0;
  const contextAfter = linesContext ?? linesAfter ?? 0;

  // Find files matching patterns
  const ignorePatterns = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/build/**"];
  const files = await findFiles(absolutePath, filePatterns, ignorePatterns);

  // Check if searchPath was a single file
  let stats;
  try {
    stats = await fs.promises.stat(absolutePath);
  } catch {
    stats = null;
  }

  const results: Array<{
    file: string;
    matches: Array<{ lineNum: number; line: string; isContext?: boolean }>;
    count: number;
  }> = [];

  // Search each file
  for (const file of files) {
    try {
      const content = await fs.promises.readFile(file, "utf-8");
      const lines = content.split("\n");

      const fileMatches: Array<{ lineNum: number; line: string; isContext?: boolean }> = [];
      const matchedLineNums = new Set<number>();

      // Find all matching lines
      if (multiline) {
        // Join all lines for cross-line matching
        const fullContent = lines.join("\n");

        // Build line offset index for O(1) line lookup
        const lineOffsets: number[] = [0];
        for (let i = 0; i < lines.length; i++) {
          lineOffsets.push(lineOffsets[i] + lines[i].length + 1);
        }

        // Binary search for line number at position
        const getLineNumber = (pos: number): number => {
          let low = 0, high = lineOffsets.length - 1;
          while (low < high) {
            const mid = Math.floor((low + high + 1) / 2);
            if (lineOffsets[mid] <= pos) low = mid;
            else high = mid - 1;
          }
          return low;
        };

        // Find all matches and mark lines they span
        regex.lastIndex = 0;
        for (const match of fullContent.matchAll(regex)) {
          if (match.index === undefined) continue;
          const startLine = getLineNumber(match.index);
          const endLine = getLineNumber(match.index + match[0].length - 1);
          for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
            matchedLineNums.add(lineNum);
          }
        }
      } else {
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          regex.lastIndex = 0; // Reset regex state
          if (regex.test(line)) {
            matchedLineNums.add(i);
          }
        }
      }

      if (matchedLineNums.size === 0) continue;

      // Build output with context
      const includedLines = new Set<number>();

      for (const lineNum of matchedLineNums) {
        // Add context before
        for (let i = Math.max(0, lineNum - contextBefore); i < lineNum; i++) {
          if (!includedLines.has(i)) {
            fileMatches.push({ lineNum: i + 1, line: lines[i], isContext: true });
            includedLines.add(i);
          }
        }

        // Add the matching line
        if (!includedLines.has(lineNum)) {
          fileMatches.push({ lineNum: lineNum + 1, line: lines[lineNum] });
          includedLines.add(lineNum);
        }

        // Add context after
        for (let i = lineNum + 1; i <= Math.min(lines.length - 1, lineNum + contextAfter); i++) {
          if (!includedLines.has(i)) {
            fileMatches.push({ lineNum: i + 1, line: lines[i], isContext: true });
            includedLines.add(i);
          }
        }
      }

      // Sort by line number
      fileMatches.sort((a, b) => a.lineNum - b.lineNum);

      const relPath = stats?.isFile() ? path.basename(file) : path.relative(absolutePath, file);

      results.push({
        file: relPath,
        matches: fileMatches,
        count: matchedLineNums.size,
      });
    } catch {
      // Skip files that can't be read (binary, permissions, etc.)
      continue;
    }
  }

  // Apply offset and limit
  let processedResults = results;
  if (offset > 0) {
    processedResults = processedResults.slice(offset);
  }
  if (headLimit && headLimit > 0) {
    processedResults = processedResults.slice(0, headLimit);
  }

  // Format output based on mode
  switch (outputMode) {
    case "files_with_matches":
      return processedResults.map((r) => r.file).join("\n");

    case "count":
      return processedResults.map((r) => `${r.file}:${r.count}`).join("\n");

    case "content": {
      const outputLines: string[] = [];
      for (const result of processedResults) {
        for (const match of result.matches) {
          if (showLineNumbers) {
            // Format: file:lineNum:content (like ripgrep)
            const separator = match.isContext ? "-" : ":";
            outputLines.push(`${result.file}:${match.lineNum}${separator}${match.line}`);
          } else {
            outputLines.push(`${result.file}:${match.line}`);
          }
        }
      }
      return outputLines.join("\n");
    }

    default:
      return processedResults.map((r) => r.file).join("\n");
  }
}

/**
 * Create method definitions for search tools
 */
export function createSearchToolMethodDefinitions(
  workspaceRoot?: string
): Record<string, MethodDefinition> {
  return {
    glob: {
      description: `Find files by glob pattern.

Returns newline-separated file paths, sorted by modification time (newest first).
Ignores node_modules and .git directories.
Limited to ${MAX_RESULTS} results.`,
      parameters: GlobArgsSchema,
      execute: async (args: unknown) => {
        return await glob(args as GlobArgs, workspaceRoot);
      },
    },
    grep: {
      description: `Search file contents with regex.

Output modes:
- files_with_matches (default): Just file paths
- content: Matching lines with file:line:content format
- count: File paths with match counts

Supports context lines (-A, -B, -C), case insensitive (-i), and multiline matching.`,
      parameters: GrepArgsSchema,
      execute: async (args: unknown) => {
        return await grep(args as GrepArgs, workspaceRoot);
      },
    },
  };
}
