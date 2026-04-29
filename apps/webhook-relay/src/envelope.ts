const encoder = new TextEncoder();

export interface RelayEnvelopeInput {
  method: string;
  path: string;
  query: string;
  timestamp: string;
  bodySha256: string;
}

export function canonicalRelayEnvelope(input: RelayEnvelopeInput): string {
  return [
    input.method.toUpperCase(),
    input.path,
    input.query,
    input.timestamp,
    input.bodySha256,
  ].join("\n");
}

export async function sha256Hex(body: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", body);
  return bytesToHex(new Uint8Array(digest));
}

export async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return bytesToHex(new Uint8Array(signature));
}

export async function signRelayEnvelope(
  secret: string,
  input: RelayEnvelopeInput,
): Promise<string> {
  return `v1=${await hmacSha256Hex(secret, canonicalRelayEnvelope(input))}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
