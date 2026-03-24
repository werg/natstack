/**
 * WebSocket protocol helpers — frame parsing, message serialization.
 *
 * sendJson/buildBinaryFrame accept any WS message type (event or control).
 * The wire format is intentionally loose at this layer — type safety is
 * enforced by callers using WsEventMessage/WsControlMessage from shared types.
 */

import type { WsEventMessage, WsControlMessage } from "@natstack/pubsub";
import type { ClientMessage, AttachmentMeta, StoredAttachment } from "./types.js";

// ── JSON send ────────────────────────────────────────────────────────────────

export function sendJson(ws: WebSocket, msg: WsEventMessage | WsControlMessage | Record<string, unknown>): void {
  ws.send(JSON.stringify(msg));
}

// ── Binary frame builder ─────────────────────────────────────────────────────

/**
 * Build a binary frame for a message with attachments.
 * Format: [0x00 marker][uint32 LE metadata length][JSON metadata][attachment bytes]
 *
 * Note: In workerd, Uint8Array is the primary binary type (no Node.js Buffer).
 */
export function buildBinaryFrame(msg: WsEventMessage | Record<string, unknown>, attachments: StoredAttachment[]): ArrayBuffer {
  const attachmentMeta = attachments.map((a) => ({
    id: a.id,
    mimeType: a.mimeType,
    name: a.name,
    size: a.size,
  }));

  const metadata = {
    ...msg,
    attachmentMeta,
  };

  const metadataStr = JSON.stringify(metadata);
  const encoder = new TextEncoder();
  const metadataBytes = encoder.encode(metadataStr);
  const metadataLen = metadataBytes.length;

  // Decode base64 attachments
  const attachmentBuffers: Uint8Array[] = [];
  let totalSize = 0;
  for (const att of attachments) {
    const binary = base64ToUint8Array(att.data);
    attachmentBuffers.push(binary);
    totalSize += binary.length;
  }

  // Build frame: 1 byte marker + 4 bytes length + metadata + attachments
  const buffer = new ArrayBuffer(1 + 4 + metadataLen + totalSize);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  view.setUint8(0, 0x00); // Binary frame marker
  view.setUint32(1, metadataLen, true); // Little-endian

  bytes.set(metadataBytes, 5);

  let offset = 5 + metadataLen;
  for (const ab of attachmentBuffers) {
    bytes.set(ab, offset);
    offset += ab.length;
  }

  return buffer;
}

// ── Binary frame parser (incoming from panel clients) ────────────────────────

export interface ParsedBinaryFrame {
  msg: ClientMessage;
  attachmentBlob: Uint8Array;
}

/**
 * Try to parse a binary WebSocket frame.
 * Returns null if the data isn't a valid binary frame.
 */
export function parseBinaryFrame(data: ArrayBuffer): ParsedBinaryFrame | null {
  if (data.byteLength < 6) return null;

  const view = new DataView(data);
  const marker = view.getUint8(0);
  if (marker !== 0x00) return null;

  const metadataLen = view.getUint32(1, true);
  if (data.byteLength < 5 + metadataLen) return null;

  const decoder = new TextDecoder();
  const metadataBytes = new Uint8Array(data, 5, metadataLen);
  const metadataStr = decoder.decode(metadataBytes);
  const msg = JSON.parse(metadataStr) as ClientMessage;

  const attachmentBlob = new Uint8Array(data, 5 + metadataLen);
  return { msg, attachmentBlob };
}

/**
 * Parse attachment data from a binary blob using metadata sizes.
 */
export function parseAttachments(
  blob: Uint8Array,
  meta: AttachmentMeta[],
  generateId: () => string,
): StoredAttachment[] {
  const attachments: StoredAttachment[] = [];
  let offset = 0;

  for (const m of meta) {
    if (offset + m.size > blob.length) break;
    const slice = blob.subarray(offset, offset + m.size);
    attachments.push({
      id: generateId(),
      data: uint8ArrayToBase64(slice),
      mimeType: m.mimeType,
      name: m.name,
      size: m.size,
    });
    offset += m.size;
  }

  return attachments;
}

// ── Base64 utilities ─────────────────────────────────────────────────────────

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
