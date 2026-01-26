/**
 * useShellEvent - React hook for subscribing to shell events.
 *
 * Automatically subscribes when mounted and unsubscribes when unmounted.
 * Events are emitted via RPC from the main process.
 */

import { useEffect, useRef } from "react";
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
  // Use ref to store the latest callback without triggering effect re-runs
  const callbackRef = useRef(callback);

  // Update ref on every render (no effect trigger)
  useEffect(() => {
    callbackRef.current = callback;
  });

  useEffect(() => {
    // Subscribe to the event
    void events.subscribe(event);

    // Listen for the event via RPC
    const channel = `event:${event}`;
    const cleanup = onRpcEvent(channel, (_fromId, payload) => {
      callbackRef.current(payload as EventPayloads[E]);
    });

    return () => {
      // Clean up listener and unsubscribe
      cleanup();
      void events.unsubscribe(event);
    };
  }, [event]); // Only depend on event, not callback
}
