/**
 * useShellEvent - React hook for subscribing to shell events.
 *
 * Automatically subscribes when mounted and unsubscribes when unmounted.
 * Events are emitted via RPC from the main process.
 */

import { useEffect, useCallback } from "react";
import { events, onRpcEvent, type EventName, type EventPayloads } from "./client.js";

// Re-export for consumers
export type { EventPayloads } from "./client.js";

/**
 * Subscribe to a shell event from the main process.
 *
 * @param event - The event name to subscribe to
 * @param callback - Function to call when the event is received
 *
 * @example
 * ```tsx
 * useShellEvent("system-theme-changed", (theme) => {
 *   console.log("Theme changed to:", theme);
 * });
 * ```
 */
export function useShellEvent<E extends EventName>(
  event: E,
  callback: (data: EventPayloads[E]) => void
): void {
  // Memoize callback to avoid re-subscribing on every render
  const stableCallback = useCallback(callback, [callback]);

  useEffect(() => {
    // Subscribe to the event
    void events.subscribe(event);

    // Listen for the event via RPC
    const channel = `event:${event}`;
    const cleanup = onRpcEvent(channel, (_fromId, payload) => {
      stableCallback(payload as EventPayloads[E]);
    });

    return () => {
      // Clean up listener and unsubscribe
      cleanup();
      void events.unsubscribe(event);
    };
  }, [event, stableCallback]);
}
