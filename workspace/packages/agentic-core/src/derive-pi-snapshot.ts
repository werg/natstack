/**
 * derivePiSnapshot — Convert a Pi `AgentMessage[]` snapshot to the chat
 * UI's flat `ChatMessage[]` rendering shape.
 *
 * Pi messages have a structured `content` array (text / image / tool call /
 * thinking blocks). The chat UI components consume the legacy ChatMessage
 * shape (one flat string per message). This deriver walks each Pi message
 * and emits one or more ChatMessage entries — one for each content block
 * that has a UI representation.
 */

import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ChatMessage } from "./derived-types.js";

interface ContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
}

function getRole(m: unknown): string | undefined {
  if (typeof m !== "object" || m === null) return undefined;
  const role = (m as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => {
      const block = c as ContentBlock;
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Derive a flat ChatMessage[] from a Pi AgentMessage[] snapshot.
 *
 * Each Pi message becomes one ChatMessage per content block that has a
 * UI representation. Tool calls produce a ChatMessage with kind="method";
 * thinking blocks produce one with contentType="thinking"; text blocks
 * produce a normal message.
 */
export function derivePiSnapshot(
  messages: ReadonlyArray<AgentMessage>,
  selfId: string | null,
): ChatMessage[] {
  const out: ChatMessage[] = [];
  let idx = 0;
  for (const raw of messages) {
    const role = getRole(raw);
    const baseId = `pi-${idx}`;
    idx++;
    if (!role) continue;
    const m = raw as { content?: unknown };

    if (role === "user") {
      out.push({
        id: baseId,
        senderId: selfId ?? "user",
        content: extractText(m.content),
        kind: "message",
        complete: true,
      });
    } else if (role === "assistant") {
      const blocks: ContentBlock[] = Array.isArray(m.content) ? (m.content as ContentBlock[]) : [];
      let blockIdx = 0;
      for (const block of blocks) {
        const blockId = `${baseId}-${blockIdx++}`;
        if (block.type === "text" && typeof block.text === "string") {
          out.push({
            id: blockId,
            senderId: "assistant",
            content: block.text,
            kind: "message",
            complete: true,
          });
        } else if (block.type === "thinking" && typeof block.thinking === "string") {
          out.push({
            id: blockId,
            senderId: "assistant",
            content: block.thinking,
            contentType: "thinking",
            complete: true,
          });
        } else if (block.type === "toolCall") {
          out.push({
            id: blockId,
            senderId: "assistant",
            content: block.name ?? "tool",
            kind: "method",
            complete: true,
            method: {
              callId: block.id ?? blockId,
              methodName: block.name ?? "tool",
              args: block.arguments,
              status: "pending",
              startedAt: Date.now(),
            },
          });
        }
      }
    } else if (role === "toolResult") {
      out.push({
        id: `${baseId}-result`,
        senderId: "assistant",
        content: extractText(m.content),
        contentType: "action",
        kind: "message",
        complete: true,
      });
    }
  }
  return out;
}
