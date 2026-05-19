import type { TerminalState } from "./types.js";

export function emptyState(): TerminalState {
  return {
    tabs: [],
    notifications: [],
    paletteHistory: [],
    notificationCenterOpen: true,
  };
}
