import { useEffect } from "react";
import type { SessionInfo, ShellApi } from "./types.js";

export function useSessionMetadata(shell: ShellApi, sessionIds: string[], onInfo: (info: SessionInfo) => void): void {
  useEffect(() => {
    const abort = new AbortController();
    for (const sessionId of sessionIds) {
      void (async () => {
        try {
          const response = await shell.watchSessionInfo(sessionId);
          const reader = response.body?.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (!abort.signal.aborted && reader) {
            const next = await reader.read();
            if (next.done) break;
            buffer += decoder.decode(next.value);
            let newline = buffer.indexOf("\n");
            while (newline >= 0) {
              const line = buffer.slice(0, newline);
              buffer = buffer.slice(newline + 1);
              if (line) onInfo(JSON.parse(line) as SessionInfo);
              newline = buffer.indexOf("\n");
            }
          }
        } catch {
          // Session metadata streams are best-effort UI state.
        }
      })();
    }
    return () => abort.abort();
  }, [shell, sessionIds.join("\0")]);
}
