/**
 * Shared types for about pages.
 * These mirror the types from src/shared/types.ts that about pages need.
 */

export interface AppInfo {
  version: string;
}

export interface ProviderInfo {
  id: string;
  name: string;
  hasApiKey: boolean;
  models: string[];
  /** True if provider uses CLI authentication instead of API key */
  usesCliAuth?: boolean;
  /** True if provider is enabled (for CLI auth providers) */
  isEnabled?: boolean;
}

export interface AvailableProvider {
  id: string;
  name: string;
  envVar: string;
  /** True if provider uses CLI authentication instead of API key */
  usesCliAuth?: boolean;
}

/**
 * Simplified model role config for IPC (string format only).
 */
export interface ModelRoleConfig {
  smart?: string;
  coding?: string;
  fast?: string;
  cheap?: string;
  [key: string]: string | undefined;
}

export interface SettingsData {
  providers: ProviderInfo[];
  modelRoles: ModelRoleConfig;
  availableProviders: AvailableProvider[];
  /** Whether at least one provider has an API key */
  hasConfiguredProviders: boolean;
}
