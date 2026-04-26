import { randomUUID } from "node:crypto";

import type { AccountIdentity, Credential, FlowConfig } from "../types.js";

const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const MAX_POLL_INTERVAL_MS = 60_000;
const SLOW_DOWN_INCREMENT_MS = 5_000;

type DeviceCodeFlowConfig = FlowConfig & {
  connectionLabel?: string;
  providerId?: string;
};

type DeviceAuthorizationResponse = {
  device_code?: string;
  user_code?: string;
  verification_uri?: string;
  verification_uri_complete?: string;
  expires_in?: number | string;
  interval?: number | string;
  error?: string;
  error_description?: string;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  scope?: string;
  token_type?: string;
  error?: string;
  error_description?: string;
};

function getProviderId(config: FlowConfig): string {
  const providerId = (config as DeviceCodeFlowConfig).providerId;
  return typeof providerId === "string" && providerId.trim().length > 0 ? providerId.trim() : config.type;
}

function getConnectionLabel(config: FlowConfig, providerId: string): string {
  const connectionLabel = (config as DeviceCodeFlowConfig).connectionLabel;

  return typeof connectionLabel === "string" && connectionLabel.trim().length > 0
    ? connectionLabel.trim()
    : `${providerId} device code`;
}

function toPositiveInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return null;
}

async function parseOAuthPayload(response: Response): Promise<Record<string, unknown>> {
  const bodyText = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (contentType.includes("application/json")) {
    return JSON.parse(bodyText) as Record<string, unknown>;
  }

  try {
    return JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    const params = new URLSearchParams(bodyText);
    const payload: Record<string, unknown> = {};

    for (const [key, value] of params.entries()) {
      payload[key] = value;
    }

    return payload;
  }
}

function createFormBody(config: FlowConfig, extraEntries: Record<string, string>): URLSearchParams {
  const body = new URLSearchParams(extraEntries);

  if (config.clientId) {
    body.set("client_id", config.clientId);
  }

  if (config.clientSecret) {
    body.set("client_secret", config.clientSecret);
  }

  return body;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function openVerificationUrl(url: string): Promise<void> {
  try {
    const imported = (await import("open")) as { default?: (target: string) => Promise<unknown> };
    const open = imported.default;

    if (typeof open === "function") {
      await open(url);
    }
  } catch {
    // Best effort only.
  }
}

function getExpiresAt(expiresIn: unknown): number | undefined {
  const seconds = toPositiveInteger(expiresIn);
  return seconds === null ? undefined : Date.now() + seconds * 1_000;
}

function getScopes(scope: unknown): string[] {
  if (typeof scope !== "string") {
    return [];
  }

  return scope
    .split(/\s+/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export async function deviceCode(config: FlowConfig): Promise<Credential | null> {
  const clientId = config.clientId?.trim();
  const deviceAuthUrl = config.deviceAuthUrl?.trim();
  const tokenUrl = config.tokenUrl?.trim();

  if (!clientId || !deviceAuthUrl || !tokenUrl) {
    return null;
  }

  const deviceResponse = await fetch(deviceAuthUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: createFormBody(config, {
      client_id: clientId,
    }),
  });

  const devicePayload = (await parseOAuthPayload(deviceResponse)) as DeviceAuthorizationResponse;

  if (!deviceResponse.ok || devicePayload.error) {
    return null;
  }

  const deviceCodeValue = typeof devicePayload.device_code === "string" ? devicePayload.device_code.trim() : "";
  const userCode = typeof devicePayload.user_code === "string" ? devicePayload.user_code.trim() : "";
  const verificationUri =
    typeof devicePayload.verification_uri === "string" ? devicePayload.verification_uri.trim() : "";
  const verificationUriComplete =
    typeof devicePayload.verification_uri_complete === "string"
      ? devicePayload.verification_uri_complete.trim()
      : "";

  if (!deviceCodeValue || !userCode || !verificationUri) {
    return null;
  }

  process.stdout.write(`User code: ${userCode}\n`);
  process.stdout.write(`Verification URL: ${verificationUri}\n`);

  void openVerificationUrl(verificationUriComplete || verificationUri);

  const expiresInSeconds = toPositiveInteger(devicePayload.expires_in);
  const expiresAt = expiresInSeconds === null ? undefined : Date.now() + expiresInSeconds * 1_000;
  let pollIntervalMs = (toPositiveInteger(devicePayload.interval) ?? 5) * 1_000;

  while (true) {
    if (expiresAt !== undefined && Date.now() >= expiresAt) {
      return null;
    }

    await delay(Math.min(pollIntervalMs, MAX_POLL_INTERVAL_MS));

    const tokenResponse = await fetch(tokenUrl, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: createFormBody(config, {
        client_id: clientId,
        device_code: deviceCodeValue,
        grant_type: DEVICE_CODE_GRANT_TYPE,
      }),
    });

    const tokenPayload = (await parseOAuthPayload(tokenResponse)) as TokenResponse;

    if (tokenPayload.error === "authorization_pending") {
      pollIntervalMs = Math.min(
        Math.max(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS) * 2,
        MAX_POLL_INTERVAL_MS,
      );
      continue;
    }

    if (tokenPayload.error === "slow_down") {
      pollIntervalMs = Math.min(pollIntervalMs + SLOW_DOWN_INCREMENT_MS, MAX_POLL_INTERVAL_MS);
      continue;
    }

    if (tokenPayload.error === "expired_token" || tokenPayload.error === "access_denied") {
      return null;
    }

    if (!tokenResponse.ok || tokenPayload.error) {
      return null;
    }

    const accessToken = typeof tokenPayload.access_token === "string" ? tokenPayload.access_token.trim() : "";

    if (!accessToken) {
      return null;
    }

    const providerId = getProviderId(config);
    const accountIdentity: AccountIdentity = {
      providerUserId: "device-user",
    };

    return {
      providerId,
      connectionId: randomUUID(),
      connectionLabel: getConnectionLabel(config, providerId),
      accountIdentity,
      accessToken,
      refreshToken:
        typeof tokenPayload.refresh_token === "string" && tokenPayload.refresh_token.trim().length > 0
          ? tokenPayload.refresh_token.trim()
          : undefined,
      scopes: getScopes(tokenPayload.scope),
      expiresAt: getExpiresAt(tokenPayload.expires_in),
    };
  }
}
