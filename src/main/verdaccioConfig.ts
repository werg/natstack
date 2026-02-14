/**
 * Centralized Verdaccio configuration for Electron-side consumers.
 *
 * In the server-as-child-process architecture, Verdaccio runs in the server.
 * Electron accesses it via URL (for HTTP-based operations like .npmrc) and
 * via RPC (for branch-aware getPackageVersion).
 *
 * Replaces scattered getVerdaccioServer() / isVerdaccioServerInitialized() imports.
 */

let _verdaccioUrl: string | null = null;
let _getPackageVersion: ((name: string) => Promise<string | null>) | null = null;

export function setVerdaccioConfig(config: {
  url: string;
  getPackageVersion: (name: string) => Promise<string | null>;
}): void {
  _verdaccioUrl = config.url;
  _getPackageVersion = config.getPackageVersion;
}

export function getVerdaccioUrl(): string | null {
  return _verdaccioUrl;
}

export function isVerdaccioReady(): boolean {
  return _verdaccioUrl !== null;
}

export function getPackageVersionResolver(): (name: string) => Promise<string | null> {
  if (!_getPackageVersion) throw new Error("Verdaccio not configured");
  return _getPackageVersion;
}
