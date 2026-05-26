import type { AgenticEvent } from "./events.js";

export const STORED_VALUE_REF_PROTOCOL = "natstack.blob-ref.v1" as const;

export const MAX_INLINE_TRAJECTORY_TEXT_BYTES = 128 * 1024;
export const MAX_INLINE_TRAJECTORY_EVENT_BYTES = 512 * 1024;
export const TRAJECTORY_BLOB_PREVIEW_CHARS = 4096;

export interface StoredValueRef {
  protocol: typeof STORED_VALUE_REF_PROTOCOL;
  digest: string;
  size: number;
  encoding: "json" | "text";
  originalBytes: number;
  preview?: string;
}

export interface BlobWriter {
  putText(value: string): Promise<{ digest: string; size: number }>;
}

export interface BlobReader {
  getText(digest: string): Promise<string | null>;
}

export interface EncodedAgenticEvent {
  event: AgenticEvent;
  eventBytes: number;
}

const UNBOUNDED_PAYLOAD_FIELDS = [
  "request",
  "result",
  "details",
  "data",
  "output",
  "error",
  "replacement",
  "body",
  "update",
  "initialState",
  "props",
  "imports",
  "schemaSourceOrPath",
  "source",
] as const;

export async function encodeAgenticEventStoredValues(
  event: AgenticEvent,
  writer: BlobWriter
): Promise<EncodedAgenticEvent> {
  const payload = event.payload as Record<string, unknown>;
  const nextPayload: Record<string, unknown> = { ...payload };

  if (typeof nextPayload["content"] === "string") {
    const stored = await blobRefForLargeText(nextPayload["content"], writer);
    if (stored) {
      nextPayload["content"] = stored.preview;
      nextPayload["contentBlob"] = stored.ref;
    }
  }

  if (typeof nextPayload["delta"] === "string") {
    const stored = await blobRefForLargeText(nextPayload["delta"], writer);
    if (stored) {
      nextPayload["delta"] = stored.preview;
      nextPayload["deltaBlob"] = stored.ref;
    }
  }

  if (Array.isArray(nextPayload["blocks"])) {
    nextPayload["blocks"] = await Promise.all(
      nextPayload["blocks"].map((block) => encodeMessageBlockStoredValues(block, writer))
    );
  }

  for (const field of UNBOUNDED_PAYLOAD_FIELDS) {
    if (!(field in nextPayload)) continue;
    const ref = await blobRefForUnboundedJson(nextPayload[field], writer);
    if (ref) nextPayload[field] = ref;
  }

  const encoded = { ...event, payload: nextPayload as AgenticEvent["payload"] };
  return { event: encoded, eventBytes: byteLength(JSON.stringify(encoded)) };
}

export async function encodeChannelPayloadStoredValues(
  payload: unknown,
  writer: BlobWriter
): Promise<unknown> {
  if (isAgenticEventLike(payload)) {
    return (await encodeAgenticEventStoredValues(payload as AgenticEvent, writer)).event;
  }
  if (
    payload === null ||
    payload === undefined ||
    typeof payload === "number" ||
    typeof payload === "boolean"
  ) {
    return payload;
  }
  if (typeof payload === "string") {
    const stored = await blobRefForLargeText(payload, writer);
    return stored?.ref ?? payload;
  }
  return await blobRefForUnboundedJson(payload, writer);
}

export function isStoredValueRef(value: unknown): value is StoredValueRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record["protocol"] === STORED_VALUE_REF_PROTOCOL &&
    typeof record["digest"] === "string" &&
    typeof record["size"] === "number" &&
    (record["encoding"] === "json" || record["encoding"] === "text");
}

export function collectStoredValueRefs(value: unknown, path = "$"): Array<{ path: string; ref: StoredValueRef }> {
  if (isStoredValueRef(value)) return [{ path, ref: value }];
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectStoredValueRefs(item, `${path}[${index}]`));
  }
  return Object.entries(value as Record<string, unknown>).flatMap(([key, item]) =>
    collectStoredValueRefs(item, `${path}.${key}`)
  );
}

export function findUnencodedAgenticEventStoredValues(event: AgenticEvent): Array<{ path: string; reason: string }> {
  const payload = event.payload as Record<string, unknown>;
  const violations: Array<{ path: string; reason: string }> = [];
  for (const field of UNBOUNDED_PAYLOAD_FIELDS) {
    if (!(field in payload)) continue;
    const value = payload[field];
    if (isInlineScalar(value) || isStoredValueRef(value)) continue;
    violations.push({ path: `payload.${field}`, reason: "unbounded field must be a StoredValueRef" });
  }
  if (typeof payload["content"] === "string" && byteLength(payload["content"]) > MAX_INLINE_TRAJECTORY_TEXT_BYTES && !isStoredValueRef(payload["contentBlob"])) {
    violations.push({ path: "payload.content", reason: "large text content requires contentBlob" });
  }
  if (typeof payload["delta"] === "string" && byteLength(payload["delta"]) > MAX_INLINE_TRAJECTORY_TEXT_BYTES && !isStoredValueRef(payload["deltaBlob"])) {
    violations.push({ path: "payload.delta", reason: "large text delta requires deltaBlob" });
  }
  const blocks = payload["blocks"];
  if (Array.isArray(blocks)) {
    blocks.forEach((block, index) => {
      if (!block || typeof block !== "object" || Array.isArray(block)) return;
      const record = block as Record<string, unknown>;
      const content = record["content"];
      const metadata = objectRecord(record["metadata"]);
      if (typeof content === "string" && byteLength(content) > MAX_INLINE_TRAJECTORY_TEXT_BYTES && !isStoredValueRef(metadata["contentBlob"])) {
        violations.push({ path: `payload.blocks[${index}].content`, reason: "large block content requires metadata.contentBlob" });
      }
    });
  }
  return violations;
}

export function assertAgenticEventStoredValuesEncoded(event: AgenticEvent): void {
  const violations = findUnencodedAgenticEventStoredValues(event);
  if (violations.length > 0) {
    const summary = violations.map((item) => `${item.path}: ${item.reason}`).join("; ");
    throw new Error(`trajectory event contains unencoded stored values: ${summary}`);
  }
}

export async function hydrateStoredValueRef(ref: StoredValueRef, reader: BlobReader): Promise<unknown> {
  const text = await reader.getText(ref.digest);
  if (text === null) return null;
  return ref.encoding === "json" ? JSON.parse(text) : text;
}

export async function hydrateStoredValueRefs(value: unknown, reader: BlobReader): Promise<unknown> {
  if (isStoredValueRef(value)) return hydrateStoredValueRef(value, reader);
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) return Promise.all(value.map((item) => hydrateStoredValueRefs(item, reader)));
  const entries = await Promise.all(
    Object.entries(value as Record<string, unknown>).map(async ([key, item]) => [
      key,
      await hydrateStoredValueRefs(item, reader),
    ] as const)
  );
  return Object.fromEntries(entries);
}

export function assertEncodedAgenticEventFits(event: AgenticEvent, maxBytes = MAX_INLINE_TRAJECTORY_EVENT_BYTES): void {
  const eventBytes = byteLength(JSON.stringify(event));
  if (eventBytes > maxBytes) {
    throw new Error(`encoded trajectory event too large: ${eventBytes} > ${maxBytes}`);
  }
}

function isAgenticEventLike(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record["kind"] === "string" &&
    !!record["payload"] &&
    typeof record["payload"] === "object" &&
    !Array.isArray(record["payload"]);
}

function isInlineScalar(value: unknown): boolean {
  return value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean";
}

async function encodeMessageBlockStoredValues(block: unknown, writer: BlobWriter): Promise<unknown> {
  if (!block || typeof block !== "object" || Array.isArray(block)) return block;
  const record = { ...(block as Record<string, unknown>) };
  if (typeof record["content"] === "string") {
    const stored = await blobRefForLargeText(record["content"], writer);
    if (stored) {
      record["content"] = stored.preview;
      record["metadata"] = {
        ...objectRecord(record["metadata"]),
        contentBlob: stored.ref,
      };
    }
  }
  return record;
}

async function blobRefForLargeText(
  value: string,
  writer: BlobWriter
): Promise<{ preview: string; ref: StoredValueRef } | null> {
  const originalBytes = byteLength(value);
  if (originalBytes <= MAX_INLINE_TRAJECTORY_TEXT_BYTES) return null;
  const blob = await writer.putText(value);
  return {
    preview: previewText(value, TRAJECTORY_BLOB_PREVIEW_CHARS),
    ref: {
      protocol: STORED_VALUE_REF_PROTOCOL,
      digest: blob.digest,
      size: blob.size,
      encoding: "text",
      originalBytes,
      preview: previewText(value, 240),
    },
  };
}

async function blobRefForUnboundedJson(value: unknown, writer: BlobWriter): Promise<StoredValueRef | null> {
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return null;
  }
  const jsonValue = JSON.stringify(value);
  const originalBytes = byteLength(jsonValue);
  const blob = await writer.putText(jsonValue);
  return {
    protocol: STORED_VALUE_REF_PROTOCOL,
    digest: blob.digest,
    size: blob.size,
    encoding: "json",
    originalBytes,
    preview: previewText(jsonValue, 240),
  };
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function previewText(value: string, limit: number): string {
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > limit ? `${compact.slice(0, limit - 3)}...` : compact;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
