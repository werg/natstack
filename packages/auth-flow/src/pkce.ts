/**
 * PKCE (Proof Key for Code Exchange, RFC 7636) helper.
 *
 * Uses the WebCrypto API (`crypto.getRandomValues` + `crypto.subtle.digest`)
 * which is available in modern Node, Electron renderer/main, and React
 * Native (the latter via expo-crypto polyfill if needed). Keeps this
 * package free of node:crypto so it can run in any client runtime.
 */

function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

/** Generate a random PKCE verifier and its SHA-256 challenge. */
export async function generatePkce(): Promise<{ verifier: string; challenge: string }> {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64urlEncode(verifierBytes);
  const encoder = new TextEncoder();
  const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(verifier));
  const challenge = base64urlEncode(new Uint8Array(hashBuffer));
  return { verifier, challenge };
}

/** Generate an opaque state token suitable for CSRF / flow correlation. */
export function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
