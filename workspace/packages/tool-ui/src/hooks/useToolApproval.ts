/**
 * Hook for managing tool approval workflow.
 *
 * Approval level is channel-global: it lives in channel config and applies
 * to all agents on the channel. The panel reads/writes it via
 * `updateChannelConfig({ approvalLevel })`.
 *
 * The DO receives config updates and caches the level, then applies it in
 * the harness approval gate for built-in tools.
 */

import { useState, useCallback, useEffect, useRef } from "react";
import type { ChannelConfig } from "@natstack/pubsub";
import type {
  ApprovalLevel,
  ToolApprovalSettings,
  UseToolApprovalResult,
} from "../types";

/**
 * Approval level definitions with labels and descriptions.
 * Shared between ToolApprovalPrompt and ToolPermissionsDropdown.
 */
export const APPROVAL_LEVELS: Record<ApprovalLevel, {
  label: string;
  shortDesc: string;
  details: string[];
}> = {
  0: {
    label: "Ask All",
    shortDesc: "Ask before every tool call",
    details: ["Request approval for all tool calls"],
  },
  1: {
    label: "Auto-Safe",
    shortDesc: "Auto-approve read-only tools",
    details: ["Read files automatically", "Request approval for write operations"],
  },
  2: {
    label: "Full Auto",
    shortDesc: "Auto-approve all tools",
    details: ["Execute all tools automatically"],
  },
};

const DEFAULT_SETTINGS: ToolApprovalSettings = {
  globalFloor: 2, // Default: Full Auto
};

/**
 * Minimal client interface for channel config access.
 * Accepts PubSubClient.
 */
interface ConfigClient {
  channelConfig?: ChannelConfig;
  updateChannelConfig?(config: Partial<ChannelConfig>): Promise<ChannelConfig>;
  onConfigChange?(handler: (config: ChannelConfig) => void): () => void;
}

export function useToolApproval(
  client: ConfigClient | null,
): UseToolApprovalResult {
  const [settings, setSettings] = useState<ToolApprovalSettings>(DEFAULT_SETTINGS);

  // Use ref so synchronous readers see the selected level before React re-renders.
  const settingsRef = useRef<ToolApprovalSettings>(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Sync approval level from channel config
  useEffect(() => {
    if (!client?.onConfigChange) return;

    // onConfigChange fires immediately with current config if available,
    // so no separate initial read is needed.
    const unsub = client.onConfigChange((config: ChannelConfig) => {
      const level = config.approvalLevel ?? 2;
      setSettings({ globalFloor: level as ApprovalLevel });
    });

    return unsub;
  }, [client]);

  const setGlobalFloor = useCallback(
    (level: ApprovalLevel) => {
      const newSettings = { globalFloor: level };
      settingsRef.current = newSettings;
      setSettings(newSettings);
      // Write to channel config — this propagates to all participants
      if (client?.updateChannelConfig) {
        void client.updateChannelConfig({ approvalLevel: level });
      }
    },
    [client]
  );

  return {
    settings,
    setGlobalFloor,
  };
}
