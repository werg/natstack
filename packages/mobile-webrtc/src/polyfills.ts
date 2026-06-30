/**
 * React Native (Hermes) web-API polyfills the WebRTC pipe's codec depends on.
 * Imported FIRST by `connect.ts` (before any `@natstack/rpc` module loads) so
 * both bundles that use this package — the native host bootstrap and the
 * post-reload workspace shell app — get them. All guarded: a future Hermes that
 * ships a native implementation wins.
 *
 *  - `ReadableStream` — streamed responses (`gateway.fetch`, the bundle-activation
 *    fetch) decode into a `ReadableStream<Uint8Array>`. RN's whatwg-fetch
 *    `Response` cannot consume a ReadableStream body, so the host reads the
 *    decoded stream directly via `getReader()` (`rpc.streamReadable`).
 *  - `TextDecoder` — Hermes has `TextEncoder` but not `TextDecoder`; the control-
 *    frame codec decodes UTF-8 JSON via `new TextDecoder().decode(bytes)`
 *    (`@natstack/rpc` `streamCodec`), and the module throws on load without it.
 */

import { ReadableStream as PonyfillReadableStream } from "web-streams-polyfill/ponyfill";

{
  const g = globalThis as { ReadableStream?: unknown };
  if (typeof g.ReadableStream === "undefined") {
    g.ReadableStream = PonyfillReadableStream;
  }
}

if (typeof (globalThis as { TextDecoder?: unknown }).TextDecoder === "undefined") {
  class MinimalTextDecoder {
    readonly encoding = "utf-8";
    readonly fatal = false;
    readonly ignoreBOM = false;

    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (input === undefined) return "";
      const bytes =
        input instanceof Uint8Array
          ? input
          : ArrayBuffer.isView(input)
            ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
            : new Uint8Array(input);

      // Decode UTF-8 → UTF-16 code units, flushing in bounded chunks to stay
      // under String.fromCharCode's argument limit and avoid O(n²) concatenation.
      let result = "";
      let units: number[] = [];
      const flush = (): void => {
        if (units.length === 0) return;
        result += String.fromCharCode.apply(null, units);
        units = [];
      };
      // Bounds-safe read (defaults past-end / truncated continuation bytes to 0).
      const at = (idx: number): number => bytes[idx] ?? 0;
      for (let i = 0; i < bytes.length; ) {
        const b0 = at(i++);
        let cp: number;
        if (b0 < 0x80) {
          cp = b0;
        } else if (b0 < 0xe0) {
          cp = ((b0 & 0x1f) << 6) | (at(i++) & 0x3f);
        } else if (b0 < 0xf0) {
          cp = ((b0 & 0x0f) << 12) | ((at(i++) & 0x3f) << 6) | (at(i++) & 0x3f);
        } else {
          cp =
            ((b0 & 0x07) << 18) |
            ((at(i++) & 0x3f) << 12) |
            ((at(i++) & 0x3f) << 6) |
            (at(i++) & 0x3f);
        }
        if (cp > 0xffff) {
          // Astral plane → UTF-16 surrogate pair.
          cp -= 0x10000;
          units.push(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
        } else {
          units.push(cp);
        }
        if (units.length >= 4096) flush();
      }
      flush();
      return result;
    }
  }

  (globalThis as { TextDecoder?: unknown }).TextDecoder = MinimalTextDecoder;
}
