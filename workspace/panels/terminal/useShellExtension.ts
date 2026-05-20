import { extensions } from "@workspace/runtime";
import { useEffect, useMemo } from "react";
import { SessionStore, sessionIdsConnectKey, useAllSessions } from "./SessionStore.js";
export { attachWithScrollback } from "./shellAttach.js";
import type { SessionInfo, ShellApi } from "./types.js";

const SHELL_EXTENSION = "@workspace-extensions/shell";
const STREAMING_METHODS = new Set<string>([
  "attach",
  "watchSessionInfo",
  "watchAllSessionInfo",
]);

export function useShellExtension(): ShellApi {
  return useMemo(
    () => extensions.use<ShellApi>(SHELL_EXTENSION, { streamingMethods: STREAMING_METHODS }),
    []
  );
}

export function useAllSessionInfo(shell: ShellApi, sessionIds: string[] = []): Record<string, SessionInfo> {
  const store = useMemo(() => new SessionStore(), []);
  const connectKey = sessionIdsConnectKey(sessionIds);
  useEffect(() => store.connect(shell, connectKey ? connectKey.split("\0") : []), [connectKey, shell, store]);
  return useAllSessions(store);
}
