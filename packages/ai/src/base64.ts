/**
 * Base64 - Portable base64 encoding utility.
 *
 * Inlined from @workspace/core/base64.ts during package rescoping.
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
