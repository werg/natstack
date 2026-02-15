/**
 * Minimal state holder for ServerInfo — avoids importing src/main/index.ts
 * (which has heavy side effects) from shared code like contextTemplate/resolver.
 */
import type { ServerInfo } from "./serverInfo.js";

let _serverInfo: ServerInfo | null = null;

/** Get the current ServerInfo (null before server init). */
export function getServerInfo(): ServerInfo | null {
  return _serverInfo;
}

/** Set the current ServerInfo (called by main entry point after server init). */
export function setServerInfo(info: ServerInfo | null): void {
  _serverInfo = info;
}
