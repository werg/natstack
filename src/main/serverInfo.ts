/**
 * ServerInfo — Electron-main's view of the server connection.
 *
 * Formerly carried hand-typed git RPC wrappers (getWorkspaceTree,
 * listBranches, listCommits, resolveRef); those had no consumers — callers
 * use typed service clients (`createTypedServiceClient` + the git schema
 * table) directly instead.
 */

import type { ServerInfoLike } from "@natstack/shared/panelInterfaces";

export type ServerInfo = ServerInfoLike;
