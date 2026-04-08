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
}

export interface AvailableProvider {
  id: string;
  name: string;
  envVar: string;
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
