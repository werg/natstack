/**
 * Edit tool — workerd port of pi-coding-agent's `dist/core/tools/edit.js`.
 *
 * Differences from upstream:
 * - File I/O goes through `RuntimeFs` (no `fs/promises`).
 * - Atomic writes use `fs.mktemp()` (added in W1d) instead of `os.tmpdir()`.
 * - The fuzzy / BOM / line-ending logic is unchanged.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";
import { Buffer } from "node:buffer";
import type { RuntimeFs } from "./runtime-fs.js";
import { resolveToCwd } from "./path-utils.js";
import {
  detectLineEnding,
  fuzzyFindText,
  generateDiffString,
  normalizeForFuzzyMatch,
  normalizeToLF,
  restoreLineEndings,
  stripBom,
} from "./edit-diff.js";

const editSchema = Type.Object({
  path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
  oldText: Type.String({ description: "Exact text to find and replace (must match exactly)" }),
  newText: Type.String({ description: "New text to replace the old text with" }),
});

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
  /** Unified diff of the changes made */
  diff: string;
  /** Line number of the first change in the new file (for editor navigation) */
  firstChangedLine?: number;
}

export function createEditTool(
  cwd: string,
  fs: RuntimeFs,
): AgentTool<typeof editSchema, EditToolDetails> {
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
    parameters: editSchema,
    execute: async (_toolCallId, { path, oldText, newText }, signal) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const absolutePath = resolveToCwd(path, cwd);

      // Check existence + read+write permission.
      try {
        await fs.access(absolutePath, fs.constants.R_OK | fs.constants.W_OK);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`File not found: ${path}`);
        }
        throw err;
      }

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const raw = await fs.readFile(absolutePath);
      const rawContent =
        typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const { bom, text: content } = stripBom(rawContent);
      const originalEnding = detectLineEnding(content);
      const normalizedContent = normalizeToLF(content);
      const normalizedOldText = normalizeToLF(oldText);
      const normalizedNewText = normalizeToLF(newText);

      const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);
      if (!matchResult.found) {
        throw new Error(
          `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
        );
      }

      const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
      const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
      const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;
      if (occurrences > 1) {
        throw new Error(
          `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
        );
      }

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const baseContent = matchResult.contentForReplacement;
      const newContent =
        baseContent.substring(0, matchResult.index) +
        normalizedNewText +
        baseContent.substring(matchResult.index + matchResult.matchLength);

      if (baseContent === newContent) {
        throw new Error(
          `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
        );
      }

      const finalContent = bom + restoreLineEndings(newContent, originalEnding);

      // Atomic write: write to a tmp file, then rename into place.
      const tmpPath = await fs.mktemp("edit-");
      await fs.writeFile(tmpPath, finalContent);
      await fs.rename(tmpPath, absolutePath);

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const diffResult = generateDiffString(baseContent, newContent);
      const content_: (TextContent | ImageContent)[] = [
        { type: "text", text: `Successfully replaced text in ${path}.` },
      ];
      return {
        content: content_,
        details: { diff: diffResult.diff, firstChangedLine: diffResult.firstChangedLine },
      };
    },
  };
}
