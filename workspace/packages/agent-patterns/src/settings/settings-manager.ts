/**
 * Settings Manager Pattern
 *
 * Provides settings management with 3-way merge support.
 * Settings are separate from agent state - they represent user preferences.
 *
 * ## Two Usage Patterns:
 *
 * 1. **With Client** (original pattern): Pass client in options for auto-persistence
 *    to pubsub session storage.
 *
 * 2. **Without Client** (new pattern): Pass `saved` settings directly. This is useful
 *    when settings are stored in agent state or managed externally.
 */

import type { AgenticClient, AgenticParticipantMetadata } from "@workspace/agentic-messaging";

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
 *
 * Either provide `client` for pubsub-backed persistence,
 * or provide `saved` for in-memory operation.
 */
export interface SettingsManagerOptions<T extends Record<string, unknown>> {
  /**
   * Agentic client for settings persistence.
   * Uses client.getSettings() and client.updateSettings().
   * Optional if using `saved` for pre-loaded settings.
   */
  client?: AgenticClient<AgenticParticipantMetadata>;

  /**
   * Default settings values.
   * Used when no saved settings exist.
   */
  defaults: T;

  /**
   * Pre-loaded saved settings (from agent state or other source).
   * If provided, load() won't fetch from client.
   * This enables the simpler pattern without async loading.
   */
  saved?: Partial<T>;

  /**
   * Initial config from agent spawn.
   * Applied on top of saved settings (highest priority).
   */
  initConfig?: Partial<T>;

  /**
   * Logger for debug output.
   */
  log?: (message: string) => void;
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
 * - **Settings**: User preferences (model, temperature)
 *
 * ## Two Usage Patterns:
 *
 * ### Pattern 1: With Client (async loading)
 * ```typescript
 * const settings = createSettingsManager<MySettings>({
 *   client: ctx.client,
 *   defaults: { temperature: 0.7 },
 *   initConfig: ctx.config,
 * });
 * await settings.load(); // Loads from pubsub session
 * ```
 *
 * ### Pattern 2: With Pre-loaded Saved Settings (sync)
 * ```typescript
 * const settings = createSettingsManager<MySettings>({
 *   defaults: { temperature: 0.7 },
 *   saved: this.state.settings,  // From agent state
 *   initConfig: ctx.config,
 * });
 * // No need to call load() - settings are already merged
 * ```
 *
 * The 3-way merge order is:
 * 1. Defaults (lowest priority)
 * 2. Saved settings (from pubsub session or pre-loaded)
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
 * // Pattern 2: Pre-loaded (recommended for agents)
 * const settings = createSettingsManager<MySettings>({
 *   defaults: {
 *     modelRole: 'fast',
 *     temperature: 0.7,
 *     maxTokens: 1024,
 *   },
 *   saved: this.state.settings,
 *   initConfig: ctx.config as Partial<MySettings>,
 *   log: (msg) => this.log.debug(msg),
 * });
 *
 * // Get current settings (no async needed)
 * const current = settings.get();
 *
 * // Update settings (persists via callback if client provided)
 * await settings.update({ temperature: 0.9 });
 * ```
 */
export function createSettingsManager<T extends Record<string, unknown>>(
  options: SettingsManagerOptions<T>
): SettingsManager<T> {
  const { client, defaults, saved, initConfig, log } = options;

  // Initialize with 3-way merge if saved settings provided
  let current: T;
  if (saved) {
    // Immediate merge: defaults → saved → initConfig
    let merged: T = { ...defaults };
    merged = deepMerge(merged, saved);
    if (initConfig) {
      merged = deepMerge(merged, initConfig);
    }
    current = merged;
    log?.(`Settings initialized with saved: ${JSON.stringify(current)}`);
  } else {
    // Start with defaults only, load() will fetch from client
    current = { ...defaults };
  }

  return {
    get(): T {
      return current;
    },

    async update(partial: Partial<T>): Promise<void> {
      // Merge into current
      current = deepMerge(current, partial);

      // Persist to pubsub session if client available
      if (client?.sessionKey) {
        await client.updateSettings(current);
        log?.(`Settings persisted: ${JSON.stringify(current)}`);
      }
    },

    async load(): Promise<T> {
      // Start with defaults
      let merged: T = { ...defaults };

      // Apply saved settings from pubsub session (if client provided and not pre-loaded)
      if (client?.sessionKey && !saved) {
        try {
          const fetchedSaved = await client.getSettings<T>();
          if (fetchedSaved) {
            merged = deepMerge(merged, fetchedSaved);
            log?.(`Settings loaded from pubsub: ${JSON.stringify(fetchedSaved)}`);
          }
        } catch {
          // Ignore errors loading settings, use defaults
          log?.("Failed to load settings from pubsub, using defaults");
        }
      } else if (saved) {
        // Re-apply pre-loaded saved settings
        merged = deepMerge(merged, saved);
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
      if (client?.sessionKey) {
        await client.updateSettings({});
        log?.("Settings reset");
      }
    },
  };
}
