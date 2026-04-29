import * as crypto from "node:crypto";

export type WebhookVerifier = (
  payload: Buffer | string,
  headers: Record<string, string>,
  secret: string,
) => boolean;

function getHeader(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) {
    return direct;
  }

  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }

  return undefined;
}

export class WebhookVerifierRegistry {
  private verifiers = new Map<string, WebhookVerifier>();

  register(name: string, verifier: WebhookVerifier): void {
    this.verifiers.set(name, verifier);
  }

  get(name: string): WebhookVerifier | undefined {
    return this.verifiers.get(name);
  }

  verify(
    name: string,
    payload: Buffer | string,
    headers: Record<string, string>,
    secret: string
  ): boolean {
    const verifier = this.get(name);
    if (!verifier) {
      return false;
    }

    return verifier(payload, headers, secret);
  }
}

export const githubHmacSha256: WebhookVerifier = (payload, headers, secret) => {
  const actualSignature = getHeader(headers, "x-hub-signature-256");
  if (!actualSignature) {
    return false;
  }

  const expectedSignature = `sha256=${crypto
    .createHmac("sha256", secret)
    .update(payload)
    .digest("hex")}`;

  const actualBuffer = Buffer.from(actualSignature, "utf8");
  const expectedBuffer = Buffer.from(expectedSignature, "utf8");

  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }

  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
};

export const slackSignatureV0: WebhookVerifier = (payload, headers, secret) => {
  const signature = getHeader(headers, "x-slack-signature");
  const timestamp = getHeader(headers, "x-slack-request-timestamp");
  if (!signature || !timestamp) {
    return false;
  }

  const baseString = `v0:${timestamp}:${typeof payload === "string" ? payload : payload.toString("utf8")}`;
  const expected = `v0=${crypto.createHmac("sha256", secret).update(baseString).digest("hex")}`;

  const sigBuf = Buffer.from(signature, "utf8");
  const expBuf = Buffer.from(expected, "utf8");
  if (sigBuf.length !== expBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(sigBuf, expBuf);
};

export const stripeSignature: WebhookVerifier = (payload, headers, secret) => {
  const sigHeader = getHeader(headers, "stripe-signature");
  if (!sigHeader) {
    return false;
  }

  const parts = sigHeader.split(",");
  let timestamp: string | undefined;
  const signatures: string[] = [];

  for (const part of parts) {
    const [key, value] = part.split("=", 2);
    if (key === "t" && value) {
      timestamp = value;
    } else if (key === "v1" && value) {
      signatures.push(value);
    }
  }

  if (!timestamp || signatures.length === 0) {
    return false;
  }

  const payloadStr = typeof payload === "string" ? payload : payload.toString("utf8");
  const expected = crypto.createHmac("sha256", secret).update(`${timestamp}.${payloadStr}`).digest("hex");

  return signatures.some((sig) => {
    const sigBuf = Buffer.from(sig, "utf8");
    const expBuf = Buffer.from(expected, "utf8");
    if (sigBuf.length !== expBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(sigBuf, expBuf);
  });
};
