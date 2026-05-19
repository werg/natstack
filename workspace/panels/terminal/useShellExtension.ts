import { extensions } from "@workspace/runtime";
import type { ShellApi } from "./types.js";

export function useShellExtension(): ShellApi {
  return extensions.use<ShellApi>("@workspace-extensions/shell");
}

export async function attachWithScrollback(shell: ShellApi, sessionId: string): Promise<Response> {
  const { text, cursor } = await shell.getScrollback(sessionId);
  const live = await shell.attach(sessionId, { after: cursor });
  if (!text) return live;
  const liveReader = live.body?.getReader();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
    },
    async pull(controller) {
      if (!liveReader) {
        controller.close();
        return;
      }
      const next = await liveReader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel() {
      void liveReader?.cancel();
    },
  });
  return new Response(stream, { headers: live.headers });
}
