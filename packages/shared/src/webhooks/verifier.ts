import * as crypto from "node:crypto";
import type { WebhookVerifier } from "./types.js";

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

export const slackSignatureV0: WebhookVerifier = () => {
  // TODO: implement
  return true;
};

export const stripeSignature: WebhookVerifier = () => {
  // TODO: implement
  return true;
};
