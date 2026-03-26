/**
 * useInlineUi — Inline UI component compilation + cleanup.
 *
 * Compiles inline UI messages (TSX components) and cleans up
 * compiled components when messages are trimmed.
 */

import { useState, useEffect, useRef } from "react";
import { CONTENT_TYPE_INLINE_UI } from "@natstack/pubsub";
import { compileComponent } from "@workspace/eval";
import { parseInlineUiData } from "../../components/InlineUiMessage";
import type { ChatMessage, InlineUiComponentEntry } from "../../types";

interface UseInlineUiOptions {
  messages: ChatMessage[];
}

export interface InlineUiState {
  inlineUiComponents: Map<string, InlineUiComponentEntry>;
}

export function useInlineUi({ messages }: UseInlineUiOptions): InlineUiState {
  const [inlineUiComponents, setInlineUiComponents] = useState<Map<string, InlineUiComponentEntry>>(new Map());

  // Compile inline UI messages
  useEffect(() => {
    const compileInlineUiMessages = async () => {
      for (const msg of messages) {
        if (msg.contentType !== CONTENT_TYPE_INLINE_UI) continue;
        const data = parseInlineUiData(msg.content);
        if (!data) continue;
        if (inlineUiComponents.has(data.id)) continue;

        try {
          const result = await compileComponent<import("react").ComponentType<{ props: Record<string, unknown>; chat: Record<string, unknown>; scope: Record<string, unknown>; scopes: Record<string, unknown> }>>(data.code);
          if (result.success) {
            setInlineUiComponents(prev => {
              const updated = new Map(prev);
              updated.set(data.id, { Component: result.Component!, cacheKey: result.cacheKey! });
              return updated;
            });
          } else {
            setInlineUiComponents(prev => {
              const updated = new Map(prev);
              updated.set(data.id, { cacheKey: data.code, error: result.error });
              return updated;
            });
          }
        } catch (err) {
          setInlineUiComponents(prev => {
            const updated = new Map(prev);
            updated.set(data.id, { cacheKey: data.code, error: err instanceof Error ? err.message : String(err) });
            return updated;
          });
        }
      }
    };
    void compileInlineUiMessages();
  }, [messages, inlineUiComponents]);

  // Cleanup when messages shrink (e.g. after trim in reducer)
  const prevMsgCountRef = useRef(0);
  useEffect(() => {
    if (messages.length >= prevMsgCountRef.current) {
      prevMsgCountRef.current = messages.length;
      return;
    }
    prevMsgCountRef.current = messages.length;

    const referencedUiIds = new Set<string>();
    for (const msg of messages) {
      if (msg.contentType === CONTENT_TYPE_INLINE_UI) {
        const data = parseInlineUiData(msg.content);
        if (data) referencedUiIds.add(data.id);
      }
    }
    setInlineUiComponents(prevComponents => {
      const next = new Map(prevComponents);
      let removedCount = 0;
      for (const [id, component] of prevComponents) {
        if (!referencedUiIds.has(id)) {
          next.delete(id);
          removedCount++;
        }
      }
      return removedCount > 0 ? next : prevComponents;
    });
  }, [messages]);

  return { inlineUiComponents };
}
