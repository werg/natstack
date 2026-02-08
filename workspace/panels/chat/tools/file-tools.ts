/**
 * File operation tools for pubsub RPC.
 *
 * Implements: file_read, file_write, file_edit, rm
 * These match Claude Code's Read, Write, Edit tools API.
 */

import * as fs from "fs";
import * as path from "path";
import type { MethodDefinition } from "@natstack/agentic-messaging";
import { resolvePath } from "./utils";
import {
  FileReadArgsSchema,
  FileWriteArgsSchema,
  FileEditArgsSchema,
  RmArgsSchema,
  type FileReadArgs,
  type FileWriteArgs,
  type FileEditArgs,
  type RmArgs,
} from "@natstack/agentic-messaging/tool-schemas";

const MAX_LINE_LENGTH = 2000;
const DEFAULT_LIMIT = 2000;

/**
 * Format line numbers like `cat -n` (right-aligned with tab separator)
 */
function formatLineNumber(lineNum: number): string {
  return `${lineNum.toString().padStart(6)}\t`;
}

/**
 * Check if a file is likely binary
 */
function isBinaryFile(buffer: Uint8Array): boolean {
  // Check for null bytes in the first 8KB
  const checkLength = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

/**
 * file_read - Read file contents with pagination
 */
export async function fileRead(args: FileReadArgs, workspaceRoot?: string): Promise<string> {
  const filePath = args.file_path;
  const offset = args.offset ?? 1;
  const limit = args.limit ?? DEFAULT_LIMIT;

  const resolvedPath = resolvePath(filePath, workspaceRoot);

  try {
    // Read file as buffer to check for binary
    const data = await fs.promises.readFile(resolvedPath);
    // Convert to Uint8Array (Buffer extends Uint8Array but TS needs explicit conversion)
    const buffer: Uint8Array = typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data);

    if (isBinaryFile(buffer)) {
      // Check if it's an image
      const ext = path.extname(resolvedPath).toLowerCase();
      const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".ico", ".svg"];
      if (imageExtensions.includes(ext)) {
        // Return base64 data URL for images
        const mimeTypes: Record<string, string> = {
          ".png": "image/png",
          ".jpg": "image/jpeg",
          ".jpeg": "image/jpeg",
          ".gif": "image/gif",
          ".webp": "image/webp",
          ".bmp": "image/bmp",
          ".ico": "image/x-icon",
          ".svg": "image/svg+xml",
        };
        const mime = mimeTypes[ext] ?? "application/octet-stream";
        // Convert Uint8Array to base64
        const base64 = btoa(String.fromCharCode(...buffer));
        return `[Image file: ${path.basename(resolvedPath)}]\ndata:${mime};base64,${base64}`;
      }
      return `[Binary file: ${path.basename(resolvedPath)} (${buffer.length} bytes)]`;
    }

    // Text file - split into lines and apply offset/limit
    const content = new TextDecoder("utf-8").decode(buffer);
    const lines = content.split("\n");

    // Apply offset (1-indexed) and limit
    const startIndex = Math.max(0, offset - 1);
    const selectedLines = lines.slice(startIndex, startIndex + limit);

    // Format output like `cat -n`
    const result = selectedLines.map((line, index) => {
      const lineNum = startIndex + index + 1;
      // Truncate long lines
      const truncatedLine = line.length > MAX_LINE_LENGTH
        ? line.slice(0, MAX_LINE_LENGTH) + "..."
        : line;
      return `${formatLineNumber(lineNum)}${truncatedLine}`;
    }).join("\n");

    return result;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`File not found: ${filePath}`);
    }
    if ((err as NodeJS.ErrnoException).code === "EISDIR") {
      throw new Error(`Cannot read directory as file: ${filePath}`);
    }
    throw err;
  }
}

/**
 * file_write - Create or overwrite a file
 */
export async function fileWrite(args: FileWriteArgs, workspaceRoot?: string): Promise<string> {
  const filePath = args.file_path;
  const content = args.content;

  const resolvedPath = resolvePath(filePath, workspaceRoot);

  // Create parent directories if needed
  const parentDir = path.dirname(resolvedPath);
  await fs.promises.mkdir(parentDir, { recursive: true });

  // Write atomically: write to temp file, then rename
  const tempPath = `${resolvedPath}.tmp.${Date.now()}`;
  try {
    await fs.promises.writeFile(tempPath, content);
    await fs.promises.rename(tempPath, resolvedPath);
  } catch (err) {
    // Clean up temp file on error
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }

  const bytes = Buffer.byteLength(content, "utf-8");
  return `Successfully wrote ${bytes} bytes to ${filePath}`;
}

/**
 * file_edit - String replacement editing
 */
export async function fileEdit(args: FileEditArgs, workspaceRoot?: string): Promise<string> {
  const { file_path: filePath, old_string: oldString, new_string: newString, replace_all: replaceAll } = args;

  if (oldString === newString) {
    throw new Error("old_string and new_string must be different");
  }

  const resolvedPath = resolvePath(filePath, workspaceRoot);

  // Read the file
  let content: string;
  try {
    const data = await fs.promises.readFile(resolvedPath, "utf-8");
    content = typeof data === "string" ? data : new TextDecoder("utf-8").decode(data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`File not found: ${filePath}`);
    }
    throw err;
  }

  // Count occurrences
  const occurrences = content.split(oldString).length - 1;

  if (occurrences === 0) {
    throw new Error(`old_string not found in file: ${filePath}`);
  }

  if (occurrences > 1 && !replaceAll) {
    throw new Error(
      `old_string found ${occurrences} times. Use replace_all=true or provide more context to make it unique.`
    );
  }

  // Perform replacement
  const newContent = replaceAll
    ? content.split(oldString).join(newString)
    : content.replace(oldString, newString);

  // Write atomically
  const tempPath = `${resolvedPath}.tmp.${Date.now()}`;
  try {
    await fs.promises.writeFile(tempPath, newContent);
    await fs.promises.rename(tempPath, resolvedPath);
  } catch (err) {
    try {
      await fs.promises.unlink(tempPath);
    } catch {
      // Ignore cleanup errors
    }
    throw err;
  }

  const replacementCount = replaceAll ? occurrences : 1;
  return `Successfully edited ${filePath} (${replacementCount} replacement${replacementCount > 1 ? "s" : ""})`;
}

/**
 * rm - Delete files or directories
 */
export async function rm(args: RmArgs, workspaceRoot?: string): Promise<{ success: boolean; deleted: string[] }> {
  const { path: targetPath, recursive } = args;

  const resolvedPath = resolvePath(targetPath, workspaceRoot);
  const deleted: string[] = [];

  try {
    const stats = await fs.promises.stat(resolvedPath);

    if (stats.isDirectory()) {
      if (!recursive) {
        // Check if directory is empty
        const entries = await fs.promises.readdir(resolvedPath);
        if (entries.length > 0) {
          throw new Error(`Directory not empty: ${targetPath}. Use recursive=true to delete non-empty directories.`);
        }
        await fs.promises.rmdir(resolvedPath);
        deleted.push(targetPath);
      } else {
        // Recursive delete - collect all paths being deleted
        const collectPaths = async (dir: string, relative: string): Promise<void> => {
          const entries = await fs.promises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const entryPath = path.join(dir, entry.name);
            const entryRelative = path.join(relative, entry.name);
            if (entry.isDirectory()) {
              await collectPaths(entryPath, entryRelative);
            }
            deleted.push(entryRelative);
          }
        };
        await collectPaths(resolvedPath, targetPath);
        await fs.promises.rm(resolvedPath, { recursive: true });
        deleted.push(targetPath);
      }
    } else {
      // File
      await fs.promises.unlink(resolvedPath);
      deleted.push(targetPath);
    }

    return { success: true, deleted };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Path not found: ${targetPath}`);
    }
    throw err;
  }
}

/**
 * Create method definitions for file tools
 */
export function createFileToolMethodDefinitions(workspaceRoot?: string): Record<string, MethodDefinition> {
  return {
    file_read: {
      description: `Read file contents with optional pagination.

Output format: Line numbers (like \`cat -n\`) with tab separator.
- Binary files return a description
- Images return base64 data URLs
- Lines longer than ${MAX_LINE_LENGTH} chars are truncated`,
      parameters: FileReadArgsSchema,
      execute: async (args: unknown) => {
        return await fileRead(args as FileReadArgs, workspaceRoot);
      },
    },
    file_write: {
      description: `Create or overwrite a file.

Creates parent directories automatically.
Writes atomically (temp file + rename).`,
      parameters: FileWriteArgsSchema,
      execute: async (args: unknown) => {
        return await fileWrite(args as FileWriteArgs, workspaceRoot);
      },
    },
    file_edit: {
      description: `Edit a file by replacing text.

- If old_string not found: error
- If old_string found multiple times without replace_all=true: error with count
- Preserves file encoding`,
      parameters: FileEditArgsSchema,
      execute: async (args: unknown) => {
        return await fileEdit(args as FileEditArgs, workspaceRoot);
      },
    },
    rm: {
      description: `Delete files or directories.

- For non-empty directories: requires recursive=true
- Returns list of deleted paths`,
      parameters: RmArgsSchema,
      execute: async (args: unknown) => {
        return await rm(args as RmArgs, workspaceRoot);
      },
    },
  };
}
