/**
 * Surface IMPORTANT agent `say` messages as shell-level toast notifications.
 *
 * The shell's NotificationBar is a single horizontal banner above the
 * panel viewport. It's intrusive (shrinks the editor) and ephemeral
 * (auto-dismisses, no notification center). So we use it sparingly:
 *
 *   - The drawer's unread badge is the PRIMARY signal — persistent,
 *     non-intrusive, visible whenever the user glances at the bottom.
 *   - Shell toasts are reserved for the case where the user is in
 *     ANOTHER window/panel and a meaningful agent message arrives.
 *
 * Importance heuristic (a message qualifies if ANY apply):
 *   1. It mentions the panel handle — the agent explicitly asked for
 *      attention (e.g. via the `mentions` field in `say`).
 *   2. It's the first agent message after at least `QUIET_PERIOD_MS`
 *      of silence — i.e. it's not part of a chatty burst.
 *
 * Notification gates:
 *   - Suppress when the panel is focused (`usePanelFocus`). The drawer's
 *     unread badge handles that case.
 *   - Suppress when the message would fail BOTH importance rules.
 *   - Deduplicate by messageId so reconnects don't re-fire.
 */

import { useEffect, useRef } from "react";
import type { PubSubClient } from "@workspace/pubsub";
import { notifications, id as panelId, focusPanel } from "@workspace/runtime";
import { usePanelFocus } from "@workspace/react";

const NOTIFICATION_TTL_MS = 5_000;
const QUIET_PERIOD_MS = 60_000;

export interface AgentMessageNotifierProps {
  client: PubSubClient | null;
  /** Open the drawer programmatically when the user clicks the notification. */
  onOpenDrawer?: () => void;
  /** The panel's own handle — used to detect "agent mentioned me" importance. */
  selfHandle?: string;
}

export function AgentMessageNotifier({ client, onOpenDrawer, selfHandle }: AgentMessageNotifierProps) {
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
            payload?: { kind?: string; payload?: { content?: string; role?: string; mentions?: string[] } };
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

          // Suppress if the user is looking at the panel — the drawer's
          // unread badge handles in-panel visibility.
          if (focusedRef.current) continue;

          // Importance rules.
          const mentionsMe = selfHandle ? (evt.payload?.mentions?.includes(selfHandle) ?? false) : false;
          const isFirstAfterQuiet = prevAgentTs === null || (ts - prevAgentTs) > QUIET_PERIOD_MS;
          const important = mentionsMe || isFirstAfterQuiet;
          if (!important) continue;

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
                  void focusPanel(panelId);
                  onOpenDrawer?.();
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
  }, [client, onOpenDrawer, selfHandle]);

  return null;
}
