/**
 * Panel helpers - resolve panel participants and call panel methods.
 *
 * Centralizes panel discovery and method invocation to keep agents consistent.
 */

import type { AgenticClient, AgenticParticipantMetadata } from "@workspace/agentic-messaging";

export interface PanelLookupOptions {
  /** Preferred panel handle (defaults to "user") */
  preferredHandle?: string;
}

export type PanelMethodCallOptions = (Parameters<AgenticClient["callMethod"]>[3] & {
  preferredHandle?: string;
}) | undefined;

/**
 * Find a panel participant in the roster.
 * Prefers handle "user" by default, falls back to any panel.
 */
export function findPanelParticipant<T extends AgenticParticipantMetadata = AgenticParticipantMetadata>(
  client: AgenticClient<T>,
  options?: PanelLookupOptions
): { id: string; metadata: T } | undefined {
  const preferredHandle = options?.preferredHandle ?? "user";
  const panels = Object.values(client.roster).filter((p) => p.metadata.type === "panel");
  return panels.find((p) => p.metadata.handle === preferredHandle) ?? panels[0];
}

/**
 * Find a panel participant or throw if none is available.
 */
export function requirePanelParticipant<T extends AgenticParticipantMetadata = AgenticParticipantMetadata>(
  client: AgenticClient<T>,
  options?: PanelLookupOptions
): { id: string; metadata: T } {
  const panel = findPanelParticipant(client, options);
  if (!panel) {
    throw new Error("No panel available");
  }
  return panel;
}

/**
 * Call a method on the panel participant.
 * Throws if no panel is available.
 */
export function callPanelMethod<T extends AgenticParticipantMetadata = AgenticParticipantMetadata>(
  client: AgenticClient<T>,
  methodName: string,
  args: unknown,
  options?: PanelMethodCallOptions
) {
  const panel = requirePanelParticipant(client, options);

  const { preferredHandle: _preferredHandle, ...callOptions } = options ?? {};
  return client.callMethod(panel.id, methodName, args, callOptions);
}
