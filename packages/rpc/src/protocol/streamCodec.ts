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

export function encodeFrame(type: FrameType, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(5 + payload.byteLength);
  frame[0] = type;
  const len = payload.byteLength;
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

export class FrameDecoder {
  private buf = new Uint8Array(0);

  constructor(private readonly onFrame: (type: FrameType, payload: Uint8Array) => void | Promise<void>) {}

  async push(chunk: Uint8Array): Promise<void> {
    if (chunk.byteLength === 0) return;
    const next = new Uint8Array(this.buf.byteLength + chunk.byteLength);
    next.set(this.buf, 0);
    next.set(chunk, this.buf.byteLength);
    this.buf = next;
    await this.drain();
  }

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
      if (this.buf.byteLength < total) return;
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

export async function decodeFramedResponseToStreaming(
  wireBody: ReadableStream<Uint8Array>,
  requestedUrl: string,
  callerSignal?: AbortSignal | null,
): Promise<Response> {
  let resolveHead!: (head: HeadFramePayload | null) => void;
  let rejectHead!: (error: unknown) => void;
  const headPromise = new Promise<HeadFramePayload | null>((resolve, reject) => {
    resolveHead = resolve;
    rejectHead = reject;
  });
  let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
  let bodyClosed = false;
  let headSeen = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      bodyController = controller;
    },
  });
  const closeBody = (): void => {
    if (bodyClosed) return;
    bodyClosed = true;
    bodyController?.close();
  };
  const errorBody = (error: unknown): void => {
    if (bodyClosed) return;
    bodyClosed = true;
    bodyController?.error(error);
  };
  const decoder = new FrameDecoder((type, payload) => {
    if (type === FRAME_HEAD) {
      try {
        headSeen = true;
        resolveHead(parseHeadFrame(payload));
      } catch (error) {
        rejectHead(error);
      }
      return;
    }
    if (type === FRAME_DATA) {
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
        parsed = { status: 502, message: "Streaming RPC error" };
      }
      const error = new Error(parsed.message) as Error & { code?: string };
      error.code = parsed.code;
      if (headSeen) errorBody(error);
      else rejectHead(error);
    }
  });
  const reader = wireBody.getReader();
  void (async () => {
    try {
      while (true) {
        if (callerSignal?.aborted) throw new Error("Streaming RPC aborted by caller");
        const { value, done } = await reader.read();
        if (done) break;
        if (value) await decoder.push(value);
      }
      if (!headSeen) resolveHead(null);
      closeBody();
    } catch (error) {
      if (!headSeen) rejectHead(error);
      else errorBody(error);
    } finally {
      reader.releaseLock();
    }
  })();
  const head = await headPromise;
  const response = new Response(stream as unknown as ConstructorParameters<typeof Response>[0], {
    status: head?.status ?? 502,
    statusText: head?.statusText ?? "Bad Gateway",
    headers: new Headers(head?.headerPairs ?? []),
  });
  const finalUrl = head?.finalUrl || requestedUrl;
  if (finalUrl) {
    try {
      Object.defineProperty(response, "url", { value: finalUrl, writable: false, configurable: true });
    } catch {
      // ignore
    }
  }
  return response;
}
