/**
 * Binary frame codec for streaming proxy fetches.
 *
 * Wire format: length-prefixed frames, each
 *
 *   [1 byte: type] [4 bytes: payload length, big-endian uint32] [payload]
 *
 * Frame types:
 *   - 0x01 HEAD   payload = utf-8 JSON `{ status, statusText, headerPairs, finalUrl }`
 *   - 0x02 DATA   payload = raw response body bytes (binary-safe)
 *   - 0x03 END    payload = utf-8 JSON `{ bytesIn }` (or empty)
 *   - 0x04 ERROR  payload = utf-8 JSON `{ status, message, code? }`
 *
 * The framing is length-prefixed (rather than newline-delimited like
 * NDJSON) so binary DATA frames carry raw bytes — no base64 overhead.
 * Length is a uint32, capping individual frames at 4 GiB which is more
 * than enough for any sane HTTP chunk size.
 */

export const FRAME_HEAD = 0x01 as const;
export const FRAME_DATA = 0x02 as const;
export const FRAME_END = 0x03 as const;
export const FRAME_ERROR = 0x04 as const;

export type FrameType =
  | typeof FRAME_HEAD
  | typeof FRAME_DATA
  | typeof FRAME_END
  | typeof FRAME_ERROR;

export interface HeadFramePayload {
  status: number;
  statusText: string;
  headerPairs: Array<[string, string]>;
  finalUrl: string;
}

export interface EndFramePayload {
  bytesIn: number;
}

export interface ErrorFramePayload {
  status: number;
  message: string;
  code?: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** Encode a single frame to a Uint8Array. */
export function encodeFrame(type: FrameType, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.byteLength);
  frame[0] = type;
  const len = payload.byteLength;
  // Big-endian uint32 length.
  frame[1] = (len >>> 24) & 0xff;
  frame[2] = (len >>> 16) & 0xff;
  frame[3] = (len >>> 8) & 0xff;
  frame[4] = len & 0xff;
  frame.set(payload, 5);
  return frame;
}

export function encodeHeadFrame(payload: HeadFramePayload): Uint8Array {
  return encodeFrame(FRAME_HEAD, textEncoder.encode(JSON.stringify(payload)));
}

export function encodeDataFrame(bytes: Uint8Array): Uint8Array {
  return encodeFrame(FRAME_DATA, bytes);
}

export function encodeEndFrame(payload: EndFramePayload): Uint8Array {
  return encodeFrame(FRAME_END, textEncoder.encode(JSON.stringify(payload)));
}

export function encodeErrorFrame(payload: ErrorFramePayload): Uint8Array {
  return encodeFrame(FRAME_ERROR, textEncoder.encode(JSON.stringify(payload)));
}

/**
 * Streaming frame decoder. Feed chunks via `push`; receive completed
 * frames via the `onFrame` callback. Partial frames are buffered
 * internally across `push` calls so the caller can pass arbitrary HTTP
 * chunk boundaries through without thinking about frame alignment.
 */
export class FrameDecoder {
  private buf = new Uint8Array(0);

  constructor(
    private readonly onFrame: (type: FrameType, payload: Uint8Array) => void | Promise<void>,
  ) {}

  async push(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) return;
    // Append the new chunk to whatever's left from the previous push.
    const next = new Uint8Array(this.buf.byteLength + chunk.byteLength);
    next.set(this.buf, 0);
    next.set(chunk, this.buf.byteLength);
    this.buf = next;
    await this.drain();
  }

  /** Returns true if all received bytes have been consumed as whole frames. */
  finished(): boolean {
    return this.buf.byteLength === 0;
  }

  private async drain(): Promise<void> {
    while (this.buf.byteLength >= 5) {
      const type = this.buf[0] as FrameType;
      const len =
        ((this.buf[1] ?? 0) << 24) |
        ((this.buf[2] ?? 0) << 16) |
        ((this.buf[3] ?? 0) << 8) |
        (this.buf[4] ?? 0);
      const total = 5 + len;
      if (this.buf.byteLength < total) {
        // Not enough bytes yet for the full payload; wait for next push.
        return;
      }
      const payload = this.buf.slice(5, total);
      this.buf = this.buf.slice(total);
      await this.onFrame(type, payload);
    }
  }
}

export function parseHeadFrame(payload: Uint8Array): HeadFramePayload {
  return JSON.parse(textDecoder.decode(payload)) as HeadFramePayload;
}

export function parseEndFrame(payload: Uint8Array): EndFramePayload {
  if (payload.byteLength === 0) return { bytesIn: 0 };
  return JSON.parse(textDecoder.decode(payload)) as EndFramePayload;
}

export function parseErrorFrame(payload: Uint8Array): ErrorFramePayload {
  return JSON.parse(textDecoder.decode(payload)) as ErrorFramePayload;
}

/**
 * Decode a binary-framed streaming response (whatever transport
 * delivered it — `POST /rpc/stream` over HTTP, a series of WS
 * stream-frame messages, etc.) into a `Response` whose body is a
 * real `ReadableStream<Uint8Array>`.
 *
 * The returned promise resolves as soon as the HEAD frame arrives —
 * the caller has `status` / `statusText` / `headers` / `url`
 * immediately, while the body keeps draining in the background. The
 * Response's `url` is set via `Object.defineProperty` since the
 * `Response` constructor has no `url` option.
 *
 * `wireBody` must be the streaming source of frame bytes from
 * whichever transport the bridge used. The function takes ownership:
 * the reader is locked, drained to EOF (or until cancelled), and
 * released.
 */
export async function decodeFramedResponseToStreaming(
  wireBody: ReadableStream<Uint8Array>,
  requestedUrl: string,
  callerSignal?: AbortSignal | null,
): Promise<Response> {
  let resolveHead!: (h: HeadFramePayload | null) => void;
  let rejectHead!: (e: unknown) => void;
  const headPromise = new Promise<HeadFramePayload | null>((resolve, reject) => {
    resolveHead = resolve;
    rejectHead = reject;
  });

  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let bodyClosed = false;
  // Track HEAD specifically (not "any first frame") — an ERROR
  // arriving as the first frame must reject the head promise so the
  // caller sees the real upstream error, not "no HEAD frame
  // received". A generic "first frame seen" flag misroutes that case
  // because `bodyController` exists from `stream`'s `start`.
  let headSeen = false;
  const closeBody = (): void => {
    if (bodyClosed) return;
    bodyClosed = true;
    bodyController?.close();
  };
  const errorBody = (err: unknown): void => {
    if (bodyClosed) return;
    bodyClosed = true;
    bodyController?.error(err);
  };

  const decoder = new FrameDecoder((type, payload) => {
    if (type === FRAME_HEAD) {
      try {
        resolveHead(parseHeadFrame(payload));
        headSeen = true;
      } catch (err) {
        rejectHead(err);
      }
      return;
    }
    if (type === FRAME_DATA) {
      // Defensive copy: FrameDecoder slices from an internal buffer
      // that it'll later discard. Copy so the consumer can hold the
      // reference safely.
      const copy = new Uint8Array(payload.byteLength);
      copy.set(payload);
      bodyController?.enqueue(copy);
      return;
    }
    if (type === FRAME_END) {
      closeBody();
      return;
    }
    if (type === FRAME_ERROR) {
      let parsed: ErrorFramePayload;
      try {
        parsed = parseErrorFrame(payload);
      } catch {
        parsed = { status: 502, message: "Streaming proxy fetch error" };
      }
      const error = new Error(parsed.message);
      (error as Error & { code?: string }).code = parsed.code;
      if (headSeen) {
        errorBody(error);
      } else {
        rejectHead(error);
      }
    }
  });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller;
    },
    cancel() {
      closeBody();
      wireBody.cancel().catch(() => {});
    },
  });

  void (async () => {
    const reader = wireBody.getReader();
    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    callerSignal?.addEventListener("abort", onAbort);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          await decoder.push(value);
        }
      }
      if (!bodyClosed) closeBody();
      resolveHead(null);
    } catch (err) {
      if (headSeen) {
        errorBody(err);
      } else {
        rejectHead(err);
      }
    } finally {
      callerSignal?.removeEventListener("abort", onAbort);
      try {
        reader.releaseLock();
      } catch {
        // ignore
      }
    }
  })();

  const head = await headPromise;
  if (!head) {
    throw new Error("Streaming proxy fetch returned no HEAD frame");
  }
  const response = new Response(stream as BodyInit, {
    status: head.status,
    statusText: head.statusText,
    headers: new Headers(head.headerPairs),
  });
  const finalUrl = head.finalUrl || requestedUrl;
  try {
    Object.defineProperty(response, "url", {
      value: finalUrl,
      writable: false,
      configurable: true,
    });
  } catch {
    // ignore — runtime locked the descriptor
  }
  return response;
}
