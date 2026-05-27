import type { AgenticEvent } from "./events.js";

export const STORED_VALUE_REF_PROTOCOL = "natstack.blob-ref.v1" as const;

export const MAX_INLINE_TRAJECTORY_TEXT_BYTES = 128 * 1024;
export const MAX_INLINE_TRAJECTORY_EVENT_BYTES = 512 * 1024;

export interface StoredValueRef {
  protocol: typeof STORED_VALUE_REF_PROTOCOL;
  digest: string;
  size: number;
  encoding: "json" | "text";
  originalBytes: number;
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

export interface BoundedJsonOptions {
  maxInlineTextBytes?: number;
  maxInlineJsonBytes?: number;
  forceJsonRefPaths?: ReadonlySet<string>;
}

const DEFAULT_FORCE_JSON_REF_PATHS = new Set([
  "$.payload.request",
  "$.payload.result",
  "$.payload.details",
  "$.payload.data",
  "$.payload.output",
  "$.payload.error",
  "$.payload.replacement",
  "$.payload.body",
  "$.payload.update",
  "$.payload.initialState",
  "$.payload.props",
  "$.payload.imports",
  "$.payload.schemaSourceOrPath",
  "$.payload.source",
]);
const REQUIRED_STORED_PAYLOAD_PATHS = DEFAULT_FORCE_JSON_REF_PATHS;

export async function encodeAgenticEventStoredValues(
  event: AgenticEvent,
  writer: BlobWriter
): Promise<EncodedAgenticEvent> {
  const eventWithStoredPayload = {
    ...event,
    payload: await encodeBoundedJsonForStorage(event.payload, writer, {
      forceJsonRefPaths: DEFAULT_FORCE_JSON_REF_PATHS,
    }, "$.payload"),
  } as AgenticEvent;
  const eventBytes = byteLength(JSON.stringify(eventWithStoredPayload));
  return { event: eventWithStoredPayload, eventBytes };
}

export async function encodeChannelPayloadStoredValues(
  payload: unknown,
  writer: BlobWriter
): Promise<unknown> {
  return encodeBoundedJsonForStorage(payload, writer, {
    forceJsonRefPaths: DEFAULT_FORCE_JSON_REF_PATHS,
  });
}

export async function encodeBoundedJsonForStorage(
  value: unknown,
  writer: BlobWriter,
  options: BoundedJsonOptions = {},
  path = "$"
): Promise<unknown> {
  if (isStoredValueRef(value)) return value;

  const maxText = options.maxInlineTextBytes ?? MAX_INLINE_TRAJECTORY_TEXT_BYTES;
  const maxJson = options.maxInlineJsonBytes ?? MAX_INLINE_TRAJECTORY_TEXT_BYTES;
  const forceJson = options.forceJsonRefPaths?.has(path) === true;

  if (typeof value === "string") {
    return forceJson || byteLength(value) > maxText
      ? storeText(value, writer)
      : value;
  }
  if (value === null || value === undefined || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value !== "object") {
    return forceJson ? storeJson(String(value), writer) : String(value);
  }

  if (forceJson) return storeJson(value, writer);

  if (Array.isArray(value)) {
    const encoded = await Promise.all(
      value.map((item, index) => encodeBoundedJsonForStorage(item, writer, options, `${path}[${index}]`))
    );
    const json = JSON.stringify(encoded);
    return byteLength(json) > maxJson ? storeJson(encoded, writer) : encoded;
  }

  const entries = await Promise.all(
    Object.entries(value as Record<string, unknown>).map(async ([key, item]) => [
      key,
      await encodeBoundedJsonForStorage(item, writer, options, `${path}.${key}`),
    ] as const)
  );
  const encoded = Object.fromEntries(entries);
  const json = JSON.stringify(encoded);
  return byteLength(json) > maxJson ? storeJson(encoded, writer) : encoded;
}

export function isStoredValueRef(value: unknown): value is StoredValueRef {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record["protocol"] === STORED_VALUE_REF_PROTOCOL &&
    typeof record["digest"] === "string" &&
    typeof record["size"] === "number" &&
    (record["encoding"] === "json" || record["encoding"] === "text") &&
    typeof record["originalBytes"] === "number";
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

export function assertNoStoredValueRefs(value: unknown, context: string): void {
  const refs = collectStoredValueRefs(value);
  if (refs.length === 0) return;
  const summary = refs.slice(0, 5).map(({ path, ref }) => `${path}:${ref.digest}`).join(", ");
  throw new Error(`${context} must be hydrated before semantic use; found stored refs at ${summary}`);
}

export function findUnencodedAgenticEventStoredValues(event: AgenticEvent): Array<{ path: string; reason: string }> {
  const violations: Array<{ path: string; reason: string }> = [];
  for (const { path, ref } of collectStoredValueRefs(event)) {
    if (path === "$.payload" || path.startsWith("$.payload.")) continue;
    violations.push({ path, reason: `stored ref is only allowed inside payload storage (${ref.digest})` });
  }
  for (const path of REQUIRED_STORED_PAYLOAD_PATHS) {
    const value = getPath(event, path);
    if (value === undefined || value === null || typeof value === "number" || typeof value === "boolean") {
      continue;
    }
    if (isStoredValueRef(value)) continue;
    violations.push({ path, reason: "storage-boundary payload field must be a StoredValueRef" });
  }
  const eventBytes = byteLength(JSON.stringify(event));
  if (eventBytes > MAX_INLINE_TRAJECTORY_EVENT_BYTES) {
    violations.push({ path: "$", reason: `encoded event too large: ${eventBytes}` });
  }
  return violations;
}

function getPath(value: unknown, path: string): unknown {
  if (path === "$") return value;
  let current = value;
  for (const segment of path.slice(2).split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
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
  if (ref.encoding === "text") return text;
  return hydrateStoredValueRefs(JSON.parse(text), reader);
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

async function storeText(value: string, writer: BlobWriter): Promise<StoredValueRef> {
  const originalBytes = byteLength(value);
  const blob = await writer.putText(value);
  return {
    protocol: STORED_VALUE_REF_PROTOCOL,
    digest: blob.digest,
    size: blob.size,
    encoding: "text",
    originalBytes,
  };
}

async function storeJson(value: unknown, writer: BlobWriter): Promise<StoredValueRef> {
  const json = JSON.stringify(value);
  const originalBytes = byteLength(json);
  const blob = await writer.putText(json);
  return {
    protocol: STORED_VALUE_REF_PROTOCOL,
    digest: blob.digest,
    size: blob.size,
    encoding: "json",
    originalBytes,
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
