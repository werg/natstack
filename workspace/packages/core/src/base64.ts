/**
 * Base64 - Portable base64 encoding/decoding utilities.
 *
 * Works in both Node.js and browser environments.
 * Used by @workspace/ai and other packages that need to encode binary data.
 */

const getBuffer = (): (typeof Buffer) | null => {
  const BufferCtor = (globalThis as unknown as { Buffer?: typeof Buffer }).Buffer;
  return typeof BufferCtor?.from === "function" ? BufferCtor : null;
};

/**
 * Encode a Uint8Array to base64 string.
 */
export function encodeBase64(data: Uint8Array): string {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError("Input must be Uint8Array");
  }
  if (data.length === 0) return "";

  const BufferCtor = getBuffer();
  if (BufferCtor) {
    return BufferCtor.from(data).toString("base64");
  }

  const btoaFn = (globalThis as unknown as { btoa?: (data: string) => string }).btoa;
  if (!btoaFn) {
    throw new Error("Base64 encoding is not available (missing btoa)");
  }

  // Use btoa with proper binary string conversion; chunk to avoid stack issues.
  const chunkSize = 8192;
  let binary = "";
  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, Math.min(i + chunkSize, data.length));
    binary += String.fromCharCode.apply(null, Array.from(chunk) as number[]);
  }
  return btoaFn(binary);
}

/**
 * Decode a base64 string to Uint8Array.
 */
export function decodeBase64(encoded: string): Uint8Array {
  if (typeof encoded !== "string") {
    throw new TypeError("Input must be string");
  }
  if (encoded.length === 0) return new Uint8Array(0);

  const BufferCtor = getBuffer();
  if (BufferCtor) {
    return new Uint8Array(BufferCtor.from(encoded, "base64"));
  }

  const atobFn = (globalThis as unknown as { atob?: (data: string) => string }).atob;
  if (!atobFn) {
    throw new Error("Base64 decoding is not available (missing atob)");
  }

  try {
    const binary = atobFn(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch (error) {
    throw new Error(
      `Failed to decode base64: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}
