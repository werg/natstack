/**
 * Base64 ↔ bytes. ONE canonical copy — these had drifted across the codebase
 * (rpc/client, runtime/gatewayFetch, runtime/credentials) between a chunked and a
 * naive implementation. The chunked encode is both stack-safe (a naive
 * `String.fromCharCode(...bytes)` overflows the call stack past ~100k elements) and
 * avoids O(n) per-byte string concatenation, so it is strictly the better default.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
