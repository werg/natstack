/**
 * Read tool — workerd port of pi-coding-agent's `dist/core/tools/read.js`.
 *
 * Differences from upstream:
 * - File I/O goes through `RuntimeFs` (no `fs/promises`).
 * - Image handling is delegated to the `image.*` RPC service (W1k); detection
 *   uses magic-byte sniffing in `image.detectMimeType` rather than the
 *   filename-extension table that pi-coding-agent ships.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { TextContent, ImageContent } from "@mariozechner/pi-ai";
import { Buffer } from "node:buffer";
import type { RuntimeFs } from "./runtime-fs.js";
import type { RpcCaller } from "@natstack/types";
import { resolveReadPath } from "./path-utils.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./truncate.js";

const readSchema = Type.Object({
  path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
  offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
  limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

export type ReadToolInput = Static<typeof readSchema>;

export interface ReadToolDetails {
  truncation?: TruncationResult;
  path?: string;
  mimeType?: string;
  size?: number;
  originalSize?: number;
  originalDimensions?: { width: number; height: number };
  dimensions?: { width: number; height: number };
  wasResized?: boolean;
}

interface ImageResizeResult {
  data: Uint8Array;
  mimeType: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  wasResized: boolean;
  dimensionNote?: string;
}

export interface ReadToolDeps {
  /** RPC caller — needed for image resize. */
  rpc?: RpcCaller;
}

export function createReadTool(
  cwd: string,
  fs: RuntimeFs,
  deps?: ReadToolDeps,
): AgentTool<typeof readSchema, ReadToolDetails> {
  return {
    name: "read",
    label: "read",
    description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
    parameters: readSchema,
    execute: async (_toolCallId, { path, offset, limit }, signal) => {
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      const absolutePath = resolveReadPath(path, cwd);

      // Check that the file exists / is readable; preserve ENOENT semantics.
      try {
        await fs.access(absolutePath, fs.constants.R_OK);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`File not found: ${path}`);
        }
        throw err;
      }

      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }

      // --- Image branch ------------------------------------------------------------------
      // Read raw bytes once; if the magic bytes look like an image we hand off
      // to the image service, otherwise we fall through to the text path with
      // the same bytes (so we never re-read the file).
      let raw: string | Buffer;
      try {
        raw = await fs.readFile(absolutePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          throw new Error(`File not found: ${path}`);
        }
        throw err;
      }

      if (raw instanceof Uint8Array && deps?.rpc) {
        const mimeType = await deps.rpc.call<string | null>(
          "main",
          "image.detectMimeType",
          raw,
        );
        if (mimeType?.startsWith("image/")) {
          const resized = await deps.rpc.call<ImageResizeResult>(
            "main",
            "image.resize",
            raw,
            mimeType,
            { maxWidth: 2000, maxHeight: 2000 },
          );
          const base64 = Buffer.from(resized.data).toString("base64");
          const content: (TextContent | ImageContent)[] = [
            { type: "image", mimeType: resized.mimeType, data: base64 },
          ];
          if (resized.dimensionNote) {
            content.unshift({ type: "text", text: resized.dimensionNote });
          }
          return {
            content,
            details: {
              path: absolutePath,
              mimeType: resized.mimeType,
              size: resized.data.byteLength,
              originalSize: raw.byteLength,
              originalDimensions: { width: resized.originalWidth, height: resized.originalHeight },
              dimensions: { width: resized.width, height: resized.height },
              wasResized: resized.wasResized,
            },
          };
        }
      }

      // --- Text branch -------------------------------------------------------------------
      const textContent =
        typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8");
      return formatTextResult(textContent, path, offset, limit);
    },
  };
}

function formatTextResult(
  textContent: string,
  displayPath: string,
  offset: number | undefined,
  limit: number | undefined,
): { content: (TextContent | ImageContent)[]; details: ReadToolDetails } {
  const allLines = textContent.split("\n");
  const totalFileLines = allLines.length;

  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;

  if (startLine >= allLines.length) {
    throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
  }

  let selectedContent: string;
  let userLimitedLines: number | undefined;
  if (limit !== undefined) {
    const endLine = Math.min(startLine + limit, allLines.length);
    selectedContent = allLines.slice(startLine, endLine).join("\n");
    userLimitedLines = endLine - startLine;
  } else {
    selectedContent = allLines.slice(startLine).join("\n");
  }

  const truncation = truncateHead(selectedContent);
  let outputText: string;
  let details: ReadToolDetails = {};

  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine] ?? "", "utf-8"));
    outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use offset=${startLineDisplay + 1} to skip past it.]`;
    details = { truncation };
  } else if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    outputText = truncation.content;
    if (truncation.truncatedBy === "lines") {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
    } else {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    }
    details = { truncation };
  } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    outputText = truncation.content;
    outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  } else {
    outputText = truncation.content;
  }

  return {
    content: [{ type: "text", text: outputText }],
    details: { ...details, path: displayPath },
  };
}
