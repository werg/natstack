import * as crypto from "node:crypto";

export type WebhookVerifierConfig =
  | {
      type: "hmac-sha256";
      headerName: string;
      secret: string;
      prefix?: string;
      encoding?: "hex" | "base64";
    }
  | {
      type: "timestamped-hmac-sha256";
      signatureHeaderName: string;
      timestampHeaderName: string;
      secret: string;
      prefix?: string;
      encoding?: "hex" | "base64";
      toleranceMs?: number;
      signedPayload: "slack-v0" | "timestamp-dot-body";
    }
  | {
      type: "bearer";
      headerName: string;
      token: string;
      scheme?: string;
    };

export interface WebhookTarget {
  source: string;
  className: string;
  objectKey: string;
  method: string;
}

export interface CreateWebhookIngressSubscriptionRequest {
  label?: string;
  target: WebhookTarget;
  verifier: WebhookVerifierConfig;
  replay?: {
    deliveryIdHeader?: string;
    ttlMs?: number;
  };
}

export interface RotateWebhookIngressSecretRequest {
  subscriptionId: string;
  secret?: string;
}

export interface WebhookIngressSubscription {
  subscriptionId: string;
  label?: string;
  ownerCallerId: string;
  ownerCallerKind: string;
  target: WebhookTarget;
  verifier: WebhookVerifierConfig;
  replay?: {
    deliveryIdHeader?: string;
    ttlMs?: number;
  };
  publicUrl: string;
  createdAt: number;
  updatedAt: number;
  revokedAt?: number;
}

export interface WebhookIngressSubscriptionSummary
  extends Omit<WebhookIngressSubscription, "verifier"> {
  verifier: Omit<WebhookVerifierConfig, "secret" | "token"> & {
    hasSecret: boolean;
  };
}

export interface RotateWebhookIngressSecretResult {
  subscription: WebhookIngressSubscriptionSummary;
  secret: string;
}

export function summarizeWebhookIngressSubscription(
  subscription: WebhookIngressSubscription,
): WebhookIngressSubscriptionSummary {
  const { verifier, ...rest } = subscription;
  if (verifier.type === "bearer") {
    const { token: _token, ...safe } = verifier;
    return { ...rest, verifier: { ...safe, hasSecret: Boolean(_token) } };
  }
  const { secret: _secret, ...safe } = verifier;
  return { ...rest, verifier: { ...safe, hasSecret: Boolean(_secret) } };
}

export function verifyWebhookPayload(
  config: WebhookVerifierConfig,
  payload: Buffer | string,
  headers: Record<string, string | string[] | undefined>,
  now = Date.now(),
): boolean {
  switch (config.type) {
    case "bearer": {
      const actual = getHeader(headers, config.headerName);
      if (!actual) return false;
      const expected = config.scheme
        ? `${config.scheme} ${config.token}`
        : config.token;
      return timingSafeStringEqual(actual, expected);
    }
    case "hmac-sha256": {
      const actual = getHeader(headers, config.headerName);
      if (!actual) return false;
      const digest = crypto
        .createHmac("sha256", config.secret)
        .update(payload)
        .digest(config.encoding ?? "hex");
      return timingSafeStringEqual(actual, `${config.prefix ?? ""}${digest}`);
    }
    case "timestamped-hmac-sha256": {
      const actual = getHeader(headers, config.signatureHeaderName);
      const timestamp = getHeader(headers, config.timestampHeaderName);
      if (!actual || !timestamp) return false;
      const parsedTs = Number(timestamp);
      if (!Number.isFinite(parsedTs)) return false;
      const tsMs = parsedTs < 10_000_000_000 ? parsedTs * 1000 : parsedTs;
      const toleranceMs = config.toleranceMs ?? 5 * 60 * 1000;
      if (Math.abs(now - tsMs) > toleranceMs) return false;
      const payloadText = typeof payload === "string" ? payload : payload.toString("utf8");
      const signedPayload = config.signedPayload === "slack-v0"
        ? `v0:${timestamp}:${payloadText}`
        : `${timestamp}.${payloadText}`;
      const digest = crypto
        .createHmac("sha256", config.secret)
        .update(signedPayload)
        .digest(config.encoding ?? "hex");
      return timingSafeStringEqual(actual, `${config.prefix ?? ""}${digest}`);
    }
  }
}

export function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target) continue;
    if (Array.isArray(value)) return value.join(",");
    return value;
  }
  return undefined;
}

export function timingSafeStringEqual(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}
