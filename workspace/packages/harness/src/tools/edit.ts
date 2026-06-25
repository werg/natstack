/**
 * Edit tool — GAD-native. Reads the base from the caller's vcs head and records
 * the change as an UNCOMMITTED working edit through `vcs.edit` (edit-first; disk
 * is a projection of the head, never written directly). It does NOT commit, so
 * nothing builds or advances `main` until a deliberate `vcs.commit` + `vcs.push`.
 * The fuzzy / BOM / line-ending matching logic is the upstream pi-coding-agent
 * behaviour.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { toVcsPath, type ToolVcs, type ToolVcsEditOp } from "./tool-vcs.js";
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
  vcs: ToolVcs
): AgentTool<typeof editSchema, EditToolDetails> {
  return {
    name: "edit",
    label: "edit",
    description:
      "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). Use this for precise, surgical edits.",
    parameters: editSchema,
    execute: async (toolCallId, input, signal) => {
      const { path, oldText, newText } = input;
      if (typeof path !== "string" || typeof oldText !== "string" || typeof newText !== "string") {
        throw new Error("edit requires path, oldText, and newText");
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      const relPath = toVcsPath(path, cwd);
      const base = await vcs.readFile(relPath);
      if (!base) throw new Error(`File not found: ${path}`);
      if (base.content.kind !== "text") {
        throw new Error(`Cannot edit binary file as text: ${path}`);
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      const { bom, text: content } = stripBom(base.content.text);
      const originalEnding = detectLineEnding(content);
      const normalizedContent = normalizeToLF(content);
      const normalizedOldText = normalizeToLF(oldText);
      const normalizedNewText = normalizeToLF(newText);

      const matchResult = fuzzyFindText(normalizedContent, normalizedOldText);
      if (!matchResult.found) {
        throw new Error(
          `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
        );
      }

      const fuzzyContent = normalizeForFuzzyMatch(normalizedContent);
      const fuzzyOldText = normalizeForFuzzyMatch(normalizedOldText);
      const occurrences = fuzzyContent.split(fuzzyOldText).length - 1;
      if (occurrences > 1) {
        throw new Error(
          `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
        );
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      const baseContent = matchResult.contentForReplacement;
      const start = matchResult.index;
      const end = matchResult.index + matchResult.matchLength;
      const newContent = baseContent.slice(0, start) + normalizedNewText + baseContent.slice(end);
      if (baseContent === newContent) {
        return {
          content: [
            {
              type: "text",
              text: `No changes made to ${path}. The replacement produced identical content.`,
            },
          ],
          details: { diff: "" },
        };
      }

      // On the common LF / no-BOM path the normalized content is byte-identical
      // to what GAD stores, so emit a surgical replacement hunk (offsets valid
      // against the base) which merges cleanly with concurrent edits elsewhere.
      // Otherwise fall back to a whole-file write that preserves BOM/endings.
      let edits: ToolVcsEditOp[];
      if (!matchResult.usedFuzzyMatch && bom === "" && originalEnding === "\n") {
        edits = [
          {
            kind: "replace",
            path: relPath,
            hunks: [
              { start, end, oldText: baseContent.slice(start, end), newText: normalizedNewText },
            ],
          },
        ];
      } else {
        edits = [
          {
            kind: "write",
            path: relPath,
            content: { kind: "text", text: bom + restoreLineEndings(newContent, originalEnding) },
          },
        ];
      }

      // Tie this edit to the authoring tool-call (the edge into the agentic
      // trajectory: file → edit → invocation → turn → session, queryable + kept
      // through commit).
      await vcs.edit({ baseStateHash: base.stateHash, edits, invocationId: toolCallId });
      if (signal?.aborted) throw new Error("Operation aborted");

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
