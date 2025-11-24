/**
 * Safe base64 encoding/decoding for binary data in IPC.
 *
 * Uses standard Web APIs (TextEncoder/TextDecoder) when available,
 * with explicit validation to prevent data corruption.
 */

/**
 * Encode binary data to base64 string for IPC transmission.
 * @throws If data is invalid or encoding fails
 */
export function encodeBase64(data: Uint8Array): string {
  if (!(data instanceof Uint8Array)) {
    throw new TypeError("Input must be Uint8Array");
  }

  if (data.length === 0) {
    return "";
  }

  // Use btoa with proper binary string conversion
  // Process in chunks to avoid stack overflow on large data
  const chunkSize = 8192;
  let result = "";

  for (let i = 0; i < data.length; i += chunkSize) {
    const chunk = data.subarray(i, Math.min(i + chunkSize, data.length));
    // Convert bytes to binary string using fromCharCode
    result += String.fromCharCode.apply(null, Array.from(chunk) as number[]);
  }

  return btoa(result);
}

/**
 * Decode base64 string back to binary data.
 * @throws If input is invalid base64 or decoding fails
 */
export function decodeBase64(encoded: string): Uint8Array {
  if (typeof encoded !== "string") {
    throw new TypeError("Input must be string");
  }

  if (encoded.length === 0) {
    return new Uint8Array(0);
  }

  try {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch (error) {
    throw new Error(`Failed to decode base64: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Validate that base64 encoding roundtrips correctly.
 * Useful for testing data integrity in tests.
 */
export function validateBase64Roundtrip(original: Uint8Array): boolean {
  try {
    const encoded = encodeBase64(original);
    const decoded = decodeBase64(encoded);

    if (decoded.length !== original.length) {
      return false;
    }

    for (let i = 0; i < original.length; i++) {
      if (decoded[i] !== original[i]) {
        return false;
      }
    }

    return true;
  } catch {
    return false;
  }
}
