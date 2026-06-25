/**
 * Write tool — GAD-native. Records a whole-file write as an UNCOMMITTED working
 * edit through `vcs.edit` (creates or overwrites; parent dirs are implicit in
 * the content-addressed tree). Disk is a projection of the head, never written
 * directly. It does NOT commit — seal milestones with `vcs.commit` + `vcs.push`.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import type { TextContent, ImageContent } from "@earendil-works/pi-ai";
import { toVcsPath, type ToolVcs } from "./tool-vcs.js";

const writeSchema = Type.Object({
  path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
  content: Type.String({ description: "Content to write to the file" }),
});

export type WriteToolInput = Static<typeof writeSchema>;

export interface WriteToolDetails {
  bytesWritten: number;
  path: string;
}

export function createWriteTool(
  cwd: string,
  vcs: ToolVcs
): AgentTool<typeof writeSchema, WriteToolDetails> {
  return {
    name: "write",
    label: "write",
    description:
      "Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
    parameters: writeSchema,
    execute: async (toolCallId, input, signal) => {
      const { path, content } = input;
      if (typeof path !== "string" || typeof content !== "string") {
        throw new Error("write requires path and content");
      }
      if (signal?.aborted) throw new Error("Operation aborted");

      const relPath = toVcsPath(path, cwd);
      // A whole-file write recorded as an uncommitted working edit on the
      // current head (overwrite semantics). No commit, no build — disk reflects
      // the working content immediately, sealed later by vcs.commit. Tagged with
      // the authoring tool-call so file → edit → invocation → turn is traversable.
      await vcs.edit({
        edits: [{ kind: "write", path: relPath, content: { kind: "text", text: content } }],
        invocationId: toolCallId,
      });
      if (signal?.aborted) throw new Error("Operation aborted");

      const out: { content: (TextContent | ImageContent)[]; details: WriteToolDetails } = {
        content: [{ type: "text", text: `Successfully wrote ${content.length} bytes to ${path}` }],
        details: { bytesWritten: content.length, path: relPath },
      };
      return out;
    },
  };
}
