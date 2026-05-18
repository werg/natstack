/**
 * Wire envelopes for the host ↔ extension RPC bridge.
 *
 * Both the host service and the in-process child runtime exchange binary
 * payloads and streams over JSON-only RPC, so they need a shared envelope
 * shape. Keep this module free of node/browser-specific imports — both
 * sides import the same types.
 */

export interface BinaryEnvelope {
  __bin: true;
  data: string;
}

export interface StreamEnvelope {
  __stream: true;
  id: string;
}

export type BodyEnvelope = BinaryEnvelope | StreamEnvelope;

export interface StreamChunkEnvelope {
  done: boolean;
  chunk?: BinaryEnvelope;
}

export function isBinaryEnvelope(value: unknown): value is BinaryEnvelope {
  return typeof value === "object"
    && value !== null
    && (value as { __bin?: unknown }).__bin === true
    && typeof (value as { data?: unknown }).data === "string";
}

export function isStreamEnvelope(value: unknown): value is StreamEnvelope {
  return typeof value === "object"
    && value !== null
    && (value as { __stream?: unknown }).__stream === true
    && typeof (value as { id?: unknown }).id === "string";
}
