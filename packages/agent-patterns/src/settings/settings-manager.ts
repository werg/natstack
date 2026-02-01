/**
 * Settings Manager Pattern
 *
 * Provides settings persistence with 3-way merge support.
 * Settings are separate from agent state - they represent user preferences
 * that persist via pubsub session storage.
 */

import type { AgenticClient, AgenticParticipantMetadata } from "@natstack/agentic-messaging";

/**
 * Deep merge utility for settings.
 * Handles nested objects while preserving arrays and primitives.
 */
function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>
): T {
  const result = { ...base };

  for (const key of Object.keys(override) as Array<keyof T>) {
    const value = override[key];

    if (value !== undefined) {
      // Deep merge objects (but not arrays)
      if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        base[key] !== null &&
        typeof base[key] === "object" &&
        !Array.isArray(base[key])
      ) {
        result[key] = deepMerge(
          base[key] as Record<string, unknown>,
          value as Record<string, unknown>
        ) as T[keyof T];
      } else {
        result[key] = value as T[keyof T];
      }
    }
  }

  return result;
}

/**
 * Options for creating a settings manager.
 */
export interface SettingsManagerOptions<T extends Record<string, unknown>> {
  /**
   * Agentic client for settings persistence.
   * Uses client.getSettings() and client.updateSettings().
   */
  client: AgenticClient<AgenticParticipantMetadata>;

  /**
   * Default settings values.
   * Used when no saved settings exist.
   */
  defaults: T;

  /**
   * Initial config from agent spawn.
   * Applied on top of saved settings (highest priority).
   */
  initConfig?: Partial<T>;
}

/**
 * Settings manager interface.
 */
export interface SettingsManager<T extends Record<string, unknown>> {
  /**
   * Get current settings (synchronous, from memory).
   */
  get(): T;

  /**
   * Update settings with partial values.
   * Deep merges and persists to pubsub session.
   *
   * @param partial - Partial settings to merge
   */
  update(partial: Partial<T>): Promise<void>;

  /**
   * Load settings from pubsub session storage.
   * Applies 3-way merge: defaults → saved → initConfig.
   *
   * @returns The merged settings
   */
  load(): Promise<T>;

  /**
   * Reset settings to defaults (clears saved settings).
   */
  reset(): Promise<void>;
}

/**
 * Create a settings manager for agent preferences.
 *
 * Settings are separate from agent state:
 * - **Agent state**: Identity data (sessionId, recoveryContext) persisted by runtime
 * - **Settings**: User preferences (model, temperature) persisted via pubsub session
 *
 * The 3-way merge order is:
 * 1. Defaults (lowest priority)
 * 2. Saved settings from pubsub session
 * 3. Init config from spawn (highest priority)
 *
 * @example
 * ```typescript
 * interface MySettings {
 *   modelRole: string;
 *   temperature: number;
 *   maxTokens: number;
 * }
 *
 * const settings = createSettingsManager<MySettings>({
 *   client: ctx.client,
 *   defaults: {
 *     modelRole: 'fast',
 *     temperature: 0.7,
 *     maxTokens: 1024,
 *   },
 *   initConfig: ctx.config as Partial<MySettings>,
 * });
 *
 * // Load settings on startup
 * await settings.load();
 *
 * // Get current settings
 * const current = settings.get();
 *
 * // Update settings
 * await settings.update({ temperature: 0.9 });
 * ```
 */
export function createSettingsManager<T extends Record<string, unknown>>(
  options: SettingsManagerOptions<T>
): SettingsManager<T> {
  const { client, defaults, initConfig } = options;

  // Current settings in memory (start with defaults)
  let current: T = { ...defaults };

  return {
    get(): T {
      return current;
    },

    async update(partial: Partial<T>): Promise<void> {
      // Merge into current
      current = deepMerge(current, partial);

      // Persist to pubsub session if available
      if (client.sessionKey) {
        await client.updateSettings(current);
      }
    },

    async load(): Promise<T> {
      // Start with defaults
      let merged: T = { ...defaults };

      // Apply saved settings from pubsub session
      if (client.sessionKey) {
        try {
          const saved = await client.getSettings<T>();
          if (saved) {
            merged = deepMerge(merged, saved);
          }
        } catch {
          // Ignore errors loading settings, use defaults
        }
      }

      // Apply init config (highest priority)
      if (initConfig) {
        merged = deepMerge(merged, initConfig);
      }

      current = merged;
      return current;
    },

    async reset(): Promise<void> {
      // Reset to defaults (but apply initConfig still)
      let merged: T = { ...defaults };
      if (initConfig) {
        merged = deepMerge(merged, initConfig);
      }
      current = merged;

      // Clear saved settings
      if (client.sessionKey) {
        await client.updateSettings({});
      }
    },
  };
}
