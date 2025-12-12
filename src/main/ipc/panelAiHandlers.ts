/**
 * AI service handlers for panel RPC calls.
 * Thin wrapper that delegates to AIHandler for actual AI operations.
 */

import type { AIHandler } from "../ai/aiHandler.js";
import { handleAiServiceCall } from "./aiHandlers.js";

/**
 * Handle AI service calls from panels.
 *
 * @param aiHandler - AIHandler instance (may be null during initialization)
 * @param sender - The webContents that sent the request (for streaming)
 * @param panelId - The calling panel's ID
 * @param method - The method name (e.g., "listRoles", "streamTextStart")
 * @param args - The method arguments
 * @returns The result of the method call
 */
export async function handleAiCall(
  aiHandler: AIHandler | null,
  sender: Electron.WebContents,
  panelId: string,
  method: string,
  args: unknown[]
): Promise<unknown> {
  return handleAiServiceCall(aiHandler, method, args, (handler, options, streamId) => {
    // Note: startPanelStream is fire-and-forget (async streaming)
    handler.startPanelStream(sender, panelId, options, streamId);
  });
}
