// Mobile shim for the handful of `node:crypto` APIs that shared code reaches
// for. Backed by `globalThis.crypto.getRandomValues`, which is polyfilled at
// app entry by `react-native-get-random-values`. That polyfill uses the
// platform CSPRNG (Android SecureRandom / iOS SecRandomCopyBytes), so output
// is cryptographically suitable for token generation etc.
//
// APIs beyond `randomBytes` throw explicitly — shared server-only code paths
// (hashing in typecheck service, cipher operations in browser-data) should
// never execute in the RN bundle, and a loud failure is better than silently
// pulling a Node-flavored implementation into mobile.

function getRandomValuesOrThrow(target: Uint8Array): Uint8Array {
  const webCrypto = (globalThis as { crypto?: { getRandomValues?: (arr: Uint8Array) => Uint8Array } }).crypto;
  if (!webCrypto || typeof webCrypto.getRandomValues !== "function") {
    throw new Error(
      "crypto.getRandomValues is unavailable. Ensure 'react-native-get-random-values' is imported before any crypto.randomBytes call.",
    );
  }
  return webCrypto.getRandomValues(target);
}

class RandomBytesBuffer {
  private readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  toString(encoding?: string): string {
    if (encoding === "hex" || encoding === undefined) {
      let out = "";
      for (let i = 0; i < this.bytes.length; i++) {
        out += (this.bytes[i] ?? 0).toString(16).padStart(2, "0");
      }
      return out;
    }
    if (encoding === "base64") {
      // Avoid Buffer (not available on RN without a polyfill).
      let binary = "";
      for (let i = 0; i < this.bytes.length; i++) binary += String.fromCharCode(this.bytes[i] ?? 0);
      if (typeof btoa !== "function") {
        throw new Error("crypto randomBytes toString('base64') requires btoa to be available");
      }
      return btoa(binary);
    }
    throw new Error(`crypto randomBytes toString(${encoding}) not implemented in mobile shim`);
  }
}

export function randomBytes(size: number): RandomBytesBuffer {
  if (!Number.isInteger(size) || size < 0) {
    throw new RangeError(`crypto.randomBytes size must be a non-negative integer; got ${size}`);
  }
  const bytes = new Uint8Array(size);
  getRandomValuesOrThrow(bytes);
  return new RandomBytesBuffer(bytes);
}

function notAvailable(name: string): never {
  throw new Error(`crypto.${name} is not available on mobile; this code path should not run in the RN bundle`);
}

export function createHash(): never { return notAvailable("createHash"); }
export function createHmac(): never { return notAvailable("createHmac"); }
export function createCipheriv(): never { return notAvailable("createCipheriv"); }
export function createDecipheriv(): never { return notAvailable("createDecipheriv"); }
export function pbkdf2Sync(): never { return notAvailable("pbkdf2Sync"); }
export function scryptSync(): never { return notAvailable("scryptSync"); }

export default {
  randomBytes,
  createHash,
  createHmac,
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  scryptSync,
};
