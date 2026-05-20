import type { ShellApi } from "./types.js";

export async function attachWithScrollback(shell: ShellApi, sessionId: string): Promise<Response> {
  const { text, cursor } = await shell.getScrollback(sessionId);
  const live = await shell.attach(sessionId, { after: cursor });
  if (!text) return live;
  const liveReader = live.body?.getReader();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(text));
      if (!liveReader) {
        controller.close();
        return;
      }
      try {
        while (true) {
          const next = await liveReader.read();
          if (next.done) {
            controller.close();
            return;
          }
          controller.enqueue(next.value);
        }
      } catch (err) {
        controller.error(err);
      }
    },
    cancel() {
      void liveReader?.cancel();
    },
  });
  return new Response(stream, { headers: live.headers });
}
