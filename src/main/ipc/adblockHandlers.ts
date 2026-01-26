/**
 * IPC handlers for ad blocking service.
 *
 * Provides shell access to ad blocking configuration and statistics.
 */

import {
  getAdBlockManager,
  type AdBlockConfig,
  type AdBlockListConfig,
  type AdBlockStats,
} from "../adblock/index.js";

/**
 * Handle ad block service calls.
 */
export async function handleAdBlockServiceCall(
  method: string,
  args: unknown[]
): Promise<unknown> {
  const manager = getAdBlockManager();

  switch (method) {
    case "getConfig":
      return manager.getConfig();

    case "setEnabled":
      await manager.setEnabled(args[0] as boolean);
      return true;

    case "setListEnabled":
      await manager.setListEnabled(
        args[0] as keyof AdBlockListConfig,
        args[1] as boolean
      );
      return true;

    case "addCustomList":
      await manager.addCustomList(args[0] as string);
      return true;

    case "removeCustomList":
      await manager.removeCustomList(args[0] as string);
      return true;

    case "addToWhitelist":
      manager.addToWhitelist(args[0] as string);
      return true;

    case "removeFromWhitelist":
      manager.removeFromWhitelist(args[0] as string);
      return true;

    case "getStats":
      return manager.getStats();

    case "resetStats":
      manager.resetStats();
      return true;

    case "rebuildEngine":
      await manager.rebuildEngine();
      return true;

    case "isActive":
      return manager.isActive();

    // Per-panel API
    case "getStatsForPanel":
      return manager.getStatsForPanel(args[0] as number);

    case "isEnabledForPanel":
      return manager.isEnabledForPanel(args[0] as number);

    case "setEnabledForPanel":
      manager.setEnabledForPanel(args[0] as number, args[1] as boolean);
      return true;

    case "resetStatsForPanel":
      manager.resetStatsForPanel(args[0] as number);
      return true;

    case "getPanelUrl":
      return manager.getPanelUrl(args[0] as number);

    default:
      throw new Error(`Unknown adblock method: ${method}`);
  }
}

// Re-export types for consumers
export type { AdBlockConfig, AdBlockListConfig, AdBlockStats };
