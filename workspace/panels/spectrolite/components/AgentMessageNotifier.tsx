/**
 * Surface IMPORTANT agent `say` messages as shell-level toast notifications.
 *
 * The dock's unread badge is the PRIMARY signal — persistent and
 * non-intrusive. Shell toasts are reserved for the case where the user is
 * in ANOTHER window/panel and a meaningful agent message arrives.
 *
 * Importance heuristic (a message qualifies if ANY apply):
 *   1. It mentions the panel handle — the agent explicitly asked for attention.
 *   2. It's the first agent message after ≥ QUIET_PERIOD_MS of silence.
 *
 * Gates: suppressed while the panel is focused; deduplicated by messageId
 * so reconnects don't re-fire.
 */

import { useEffect, useRef } from "react";
import { notifications, id as panelId, panel } from "@workspace/runtime";
import { usePanelFocus } from "@workspace/react";
import { useApp, useAppState } from "../app/context";
import { PANEL_HANDLE } from "../app/sessionController";

const NOTIFICATION_TTL_MS = 5_000;
const QUIET_PERIOD_MS = 60_000;

export function AgentMessageNotifier() {
  const app = useApp();
  const client = useAppState((s) => s.client);
  const focused = usePanelFocus();
  const focusedRef = useRef(focused);
  focusedRef.current = focused;
  const seenRef = useRef(new Set<string>());
  const lastAgentMessageTsRef = useRef<number | null>(null);

  useEffect(() => {
    if (!client) return;
    let cancelled = false;
    (async () => {
      try {
        for await (const event of client.events({ includeReplay: false, includeSignals: false })) {
          if (cancelled) return;
          const wire = event as unknown as {
            type?: string;
            messageId?: string;
            senderId?: string;
            ts?: number;
            senderMetadata?: { handle?: string; name?: string; type?: string };
            payload?: { kind?: string; payload?: { content?: string; mentions?: string[] } };
          };
          if (wire.type !== "agentic.trajectory.v1/event") continue;
          const evt = wire.payload;
          if (!evt || evt.kind !== "message.completed") continue;
          const content = evt.payload?.content;
          if (typeof content !== "string" || !content) continue;
          if (wire.senderMetadata?.type === "panel") continue;

          const id = wire.messageId ?? `${wire.senderId ?? "?"}-${wire.ts ?? Date.now()}`;
          if (seenRef.current.has(id)) continue;
          seenRef.current.add(id);

          const ts = wire.ts ?? Date.now();
          const prevAgentTs = lastAgentMessageTsRef.current;
          lastAgentMessageTsRef.current = ts;

          // Suppress if the user is looking at the panel — the dock's
          // unread badge handles in-panel visibility.
          if (focusedRef.current) continue;

          const mentionsMe = evt.payload?.mentions?.includes(PANEL_HANDLE) ?? false;
          const isFirstAfterQuiet = prevAgentTs === null || (ts - prevAgentTs) > QUIET_PERIOD_MS;
          if (!mentionsMe && !isFirstAfterQuiet) continue;

          const senderHandle = wire.senderMetadata?.handle ?? wire.senderMetadata?.name ?? "agent";
          const preview = content.length > 140 ? `${content.slice(0, 140)}…` : content;
          try {
            await notifications.show({
              type: "info",
              title: `@${senderHandle}`,
              message: preview,
              ttl: NOTIFICATION_TTL_MS,
              actions: [{
                label: "Open chat",
                variant: "soft",
                onClick: () => {
                  void panel.focusPanel(panelId);
                  app.session.openDock();
                },
              }],
            });
          } catch (err) {
            console.debug("[Spectrolite] notification failed:", err);
          }
        }
      } catch (err) {
        if (!cancelled) console.warn("[Spectrolite] notifier stream ended:", err);
      }
    })();
    return () => { cancelled = true; };
  }, [client, app]);

  return null;
}
