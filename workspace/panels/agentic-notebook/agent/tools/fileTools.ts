import type { FileSystem } from "../../storage/ChatStore";
import type { AgentTool } from "../AgentSession";

/**
 * Tool execution result format.
 */
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

// File operation limits (OPFS is sandboxed so these are for performance/UX, not security)
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB - reasonable for code files
const MAX_READ_SIZE = MAX_FILE_SIZE; // Same limit for reads
const MAX_LIST_ENTRIES = 1000; // Max files to return from list_files

/**
 * Validate a file path to prevent directory traversal attacks.
 * Returns an error message if invalid, undefined if valid.
 */
function validatePath(path: string): string | undefined {
  // Reject empty paths
  if (!path || path.trim() === "") {
    return "Path cannot be empty";
  }

  // Reject paths with directory traversal
  if (path.includes("..")) {
    return "Path cannot contain '..'";
  }

  return undefined;
}

/**
 * Safely stringify a value, handling circular references.
 */
function safeStringify(value: unknown, indent?: number): string {
  const seen = new WeakSet();
  return JSON.stringify(
    value,
    (_key, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) {
          return "[Circular Reference]";
        }
        seen.add(val);
      }
      return val;
    },
    indent
  );
}

/**
 * Escape special regex characters.
 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Join two path segments while avoiding duplicate slashes.
 */
function joinPath(base: string, child: string): string {
  if (base === "/") {
    return `/${child}`;
  }
  return base.endsWith("/") ? `${base}${child}` : `${base}/${child}`;
}

const TREE_ENTRY_LIMIT = 500;

/**
 * Build a simple text tree of a directory.
 */
async function buildFileTree(
  fs: FileSystem,
  rootPath: string
): Promise<{ tree: string; truncated: boolean }> {
  const lines: string[] = [];
  const rootStat = await fs.stat(rootPath);
  const rootIsDir = rootStat.isDirectory();
  let truncated = false;

  lines.push(`${rootPath}${rootIsDir ? "/" : ""}`);

  if (!rootIsDir) {
    return { tree: lines.join("\n"), truncated };
  }

  const walk = async (currentPath: string, prefix: string): Promise<void> => {
    if (lines.length >= TREE_ENTRY_LIMIT) {
      truncated = true;
      return;
    }

    let entries: string[];
    try {
      entries = await fs.readdir(currentPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      lines.push(`${prefix}[error opening ${currentPath}: ${message}]`);
      return;
    }

    entries.sort((a, b) => a.localeCompare(b));

    for (const entry of entries) {
      if (lines.length >= TREE_ENTRY_LIMIT) {
        truncated = true;
        return;
      }

      const fullPath = joinPath(currentPath, entry);
      let isDir = false;

      try {
        isDir = (await fs.stat(fullPath)).isDirectory();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown error";
        lines.push(`${prefix}- ${entry} (stat failed: ${message})`);
        continue;
      }

      lines.push(`${prefix}- ${entry}${isDir ? "/" : ""}`);

      if (isDir) {
        await walk(fullPath, `${prefix}  `);
      }
    }
  };

  await walk(rootPath, "");
  return { tree: lines.join("\n"), truncated };
}

/**
 * Result of applying a patch.
 */
interface PatchResult {
  success: boolean;
  content?: string;
  error?: string;
  linesChanged?: number;
}

/**
 * Apply a unified diff patch to content.
 * Supports both unified diff format and simple search/replace format.
 */
function applyPatch(originalContent: string, patch: string): PatchResult {
  // Try to detect patch format
  if (patch.includes("<<<<<<< SEARCH") && patch.includes(">>>>>>> REPLACE")) {
    return applySearchReplacePatch(originalContent, patch);
  } else if (patch.startsWith("---") || patch.startsWith("+++") || patch.includes("@@")) {
    return applyUnifiedDiffPatch(originalContent, patch);
  } else {
    return {
      success: false,
      error: "Unknown patch format. Use either SEARCH/REPLACE format or unified diff format.",
    };
  }
}

/**
 * Apply search/replace format patch.
 * Format:
 * <<<<<<< SEARCH
 * old content
 * =======
 * new content
 * >>>>>>> REPLACE
 */
function applySearchReplacePatch(content: string, patch: string): PatchResult {
  const blocks = patch.split("<<<<<<< SEARCH");
  let result = content;
  let totalChanges = 0;

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i];
    const parts = block.split("=======");

    if (parts.length !== 2) {
      return {
        success: false,
        error: `Invalid SEARCH/REPLACE block ${i}: missing separator`,
      };
    }

    const replaceEndIndex = parts[1].indexOf(">>>>>>> REPLACE");
    if (replaceEndIndex === -1) {
      return {
        success: false,
        error: `Invalid SEARCH/REPLACE block ${i}: missing end marker`,
      };
    }

    const searchText = parts[0].trim();
    const replaceText = parts[1].substring(0, replaceEndIndex).trim();

    // Count occurrences
    const occurrences = (result.match(new RegExp(escapeRegExp(searchText), "g")) || []).length;

    if (occurrences === 0) {
      return {
        success: false,
        error: `SEARCH block ${i} not found in file. Make sure the content exactly matches.`,
      };
    }

    if (occurrences > 1) {
      return {
        success: false,
        error: `SEARCH block ${i} matches ${occurrences} locations. Make the search more specific.`,
      };
    }

    result = result.replace(searchText, replaceText);
    totalChanges++;
  }

  return {
    success: true,
    content: result,
    linesChanged: totalChanges,
  };
}

/**
 * Apply unified diff format patch.
 */
function applyUnifiedDiffPatch(content: string, patch: string): PatchResult {
  const lines = content.split("\n");
  const patchLines = patch.split("\n");

  let currentLine = 0;
  let linesChanged = 0;
  const result: string[] = [];

  for (let i = 0; i < patchLines.length; i++) {
    const line = patchLines[i];

    // Skip header lines
    if (line.startsWith("---") || line.startsWith("+++")) {
      continue;
    }

    // Parse hunk header
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (match) {
        const oldStart = parseInt(match[1], 10) - 1; // Convert to 0-indexed

        // Copy lines before the hunk
        while (currentLine < oldStart) {
          result.push(lines[currentLine]);
          currentLine++;
        }
      }
      continue;
    }

    // Process diff lines
    if (line.startsWith("-")) {
      // Remove line
      currentLine++;
      linesChanged++;
    } else if (line.startsWith("+")) {
      // Add line
      result.push(line.substring(1));
      linesChanged++;
    } else if (line.startsWith(" ")) {
      // Context line
      result.push(line.substring(1));
      currentLine++;
    }
  }

  // Copy remaining lines
  while (currentLine < lines.length) {
    result.push(lines[currentLine]);
    currentLine++;
  }

  return {
    success: true,
    content: result.join("\n"),
    linesChanged,
  };
}

/**
 * Create file operation tools for the agent.
 */
export function createFileTools(fs: FileSystem): AgentTool[] {
  return [
    {
      name: "read_file",
      description: "Read the contents of a file from OPFS storage",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to read",
          },
        },
        required: ["path"],
      },
      execute: async (args): Promise<ToolResult> => {
        try {
          const path = args.path as string;

          const pathError = validatePath(path);
          if (pathError) {
            return {
              content: [{ type: "text", text: `Invalid path: ${pathError}` }],
              isError: true,
            };
          }

          const content = await fs.readFile(path, "utf-8");

          // Check size after reading (FileSystem stat doesn't provide size)
          if (content.length > MAX_READ_SIZE) {
            return {
              content: [
                {
                  type: "text",
                  text: `File too large (${content.length} bytes, max ${MAX_READ_SIZE} bytes). Consider using a more specific approach for large files.`,
                },
              ],
              isError: true,
            };
          }

          return {
            content: [{ type: "text", text: content }],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error reading file: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
            isError: true,
          };
        }
      },
    },

    {
      name: "write_file",
      description: "Write content to a file in OPFS storage",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to write",
          },
          content: {
            type: "string",
            description: "Content to write to the file",
          },
        },
        required: ["path", "content"],
      },
      execute: async (args): Promise<ToolResult> => {
        try {
          const path = args.path as string;
          const content = args.content as string;

          const pathError = validatePath(path);
          if (pathError) {
            return {
              content: [{ type: "text", text: `Invalid path: ${pathError}` }],
              isError: true,
            };
          }

          // Check content size before writing
          if (content.length > MAX_FILE_SIZE) {
            return {
              content: [
                {
                  type: "text",
                  text: `Content too large to write (${content.length} bytes, max ${MAX_FILE_SIZE} bytes). Consider breaking into smaller files.`,
                },
              ],
              isError: true,
            };
          }

          await fs.writeFile(path, content);
          return {
            content: [
              {
                type: "text",
                text: `Successfully wrote ${content.length} bytes to ${path}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error writing file: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
            isError: true,
          };
        }
      },
    },

    {
      name: "apply_diff",
      description:
        "Apply a patch to a file. Supports two formats:\n" +
        "1. Unified diff format (starting with --- or @@ markers)\n" +
        "2. SEARCH/REPLACE format:\n" +
        "   <<<<<<< SEARCH\n" +
        "   old content\n" +
        "   =======\n" +
        "   new content\n" +
        "   >>>>>>> REPLACE",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to modify",
          },
          diff: {
            type: "string",
            description: "Patch to apply (unified diff or SEARCH/REPLACE format)",
          },
        },
        required: ["path", "diff"],
      },
      execute: async (args): Promise<ToolResult> => {
        try {
          const path = args.path as string;
          const diff = args.diff as string;

          const pathError = validatePath(path);
          if (pathError) {
            return {
              content: [{ type: "text", text: `Invalid path: ${pathError}` }],
              isError: true,
            };
          }

          // Read current content
          let content: string;
          try {
            content = await fs.readFile(path, "utf-8");
          } catch {
            content = "";
          }

          // Apply patch using comprehensive implementation
          const result = applyPatch(content, diff);

          if (!result.success) {
            return {
              content: [{ type: "text", text: `Failed to apply patch: ${result.error}` }],
              isError: true,
            };
          }

          await fs.writeFile(path, result.content!);
          return {
            content: [
              {
                type: "text",
                text: `Successfully applied patch to ${path}${result.linesChanged ? ` (${result.linesChanged} changes)` : ""}`,
              },
            ],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error applying patch: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
            isError: true,
          };
        }
      },
    },

    {
      name: "search_replace",
      description:
        "Replace a specific string in a file. The search string must match exactly once in the file.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to modify",
          },
          old_string: {
            type: "string",
            description: "The exact string to find and replace (must be unique in the file)",
          },
          new_string: {
            type: "string",
            description: "The string to replace it with",
          },
        },
        required: ["path", "old_string", "new_string"],
      },
      execute: async (args): Promise<ToolResult> => {
        try {
          const path = args.path as string;
          const oldString = args.old_string as string;
          const newString = args.new_string as string;

          const pathError = validatePath(path);
          if (pathError) {
            return {
              content: [{ type: "text", text: `Invalid path: ${pathError}` }],
              isError: true,
            };
          }

          const content = await fs.readFile(path, "utf-8");

          // Count occurrences to ensure uniqueness
          const occurrences = (content.match(new RegExp(escapeRegExp(oldString), "g")) || [])
            .length;

          if (occurrences === 0) {
            return {
              content: [{ type: "text", text: "String not found in file" }],
              isError: true,
            };
          }

          if (occurrences > 1) {
            return {
              content: [
                {
                  type: "text",
                  text: `String found ${occurrences} times. Make the search string more specific to match exactly once.`,
                },
              ],
              isError: true,
            };
          }

          // Replace exactly once (validated above that there's only one)
          const newContent = content.replace(oldString, newString);
          await fs.writeFile(path, newContent);

          return {
            content: [{ type: "text", text: `Successfully replaced string in ${path}` }],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
            isError: true,
          };
        }
      },
    },

    {
      name: "list_files",
      description: "List files in a directory",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to list",
          },
        },
        required: ["path"],
      },
      execute: async (args): Promise<ToolResult> => {
        try {
          const path = args.path as string;

          const pathError = validatePath(path);
          if (pathError) {
            return {
              content: [{ type: "text", text: `Invalid path: ${pathError}` }],
              isError: true,
            };
          }

          const entries = await fs.readdir(path);

          // Limit number of entries returned
          if (entries.length > MAX_LIST_ENTRIES) {
            return {
              content: [
                {
                  type: "text",
                  text: `Directory has ${entries.length} entries (max ${MAX_LIST_ENTRIES}). Showing first ${MAX_LIST_ENTRIES}:\n${entries.slice(0, MAX_LIST_ENTRIES).join("\n")}\n\n... and ${entries.length - MAX_LIST_ENTRIES} more. Consider using a more specific path or file_tree tool.`,
                },
              ],
            };
          }

          return {
            content: [{ type: "text", text: entries.join("\n") }],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error listing directory: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
            isError: true,
          };
        }
      },
    },

    {
      name: "file_tree",
      description: "Return the file tree for a path in OPFS storage",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Directory path to inspect",
          },
        },
        required: ["path"],
      },
      execute: async (args): Promise<ToolResult> => {
        try {
          const path = args.path as string;

          const pathError = validatePath(path);
          if (pathError) {
            return {
              content: [{ type: "text", text: `Invalid path: ${pathError}` }],
              isError: true,
            };
          }

          const { tree, truncated } = await buildFileTree(fs, path);
          const suffix = truncated
            ? `\n\n[truncated after ${TREE_ENTRY_LIMIT} entries]`
            : "";

          return {
            content: [{ type: "text", text: `${tree}${suffix}` }],
          };
        } catch (error) {
          return {
            content: [
              {
                type: "text",
                text: `Error building file tree: ${error instanceof Error ? error.message : "Unknown error"}`,
              },
            ],
            isError: true,
          };
        }
      },
    },
  ];
}

// Export utilities for use elsewhere
export { safeStringify, validatePath };
