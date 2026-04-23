import { createSign, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { Credential, FlowConfig } from "../types.js";

type GithubAppInstallationFlowConfig = FlowConfig & {
  connectionLabel?: string;
  providerId?: string;
};

interface InstallationTokenResponse {
  token?: string;
  expires_at?: string;
}

function base64UrlEncode(value: string | Buffer): string {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function loadPrivateKey(privateKeyValue: string): Promise<string | null> {
  const normalizedValue = privateKeyValue.trim();

  if (normalizedValue.startsWith("-----BEGIN")) {
    return normalizedValue.replace(/\\n/g, "\n");
  }

  try {
    return await readFile(normalizedValue, "utf8");
  } catch {
    return null;
  }
}

function createAppJwt(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64UrlEncode(
    JSON.stringify({
      iss: appId,
      iat: now - 60,
      exp: now + 600,
    }),
  );
  const unsignedToken = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");

  signer.update(unsignedToken);
  signer.end();

  const signature = signer.sign(privateKey);
  return `${unsignedToken}.${base64UrlEncode(signature)}`;
}

export async function githubAppInstallation(config: FlowConfig): Promise<Credential | null> {
  const appId = process.env.GITHUB_APP_ID?.trim();
  const privateKeyValue = process.env.GITHUB_APP_PRIVATE_KEY?.trim();
  const installationId = process.env.GITHUB_APP_INSTALLATION_ID?.trim();

  if (!appId || !privateKeyValue || !installationId) {
    return null;
  }

  const privateKey = await loadPrivateKey(privateKeyValue);

  if (!privateKey) {
    return null;
  }

  const jwt = createAppJwt(appId, privateKey);
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${jwt}`,
      },
    },
  );

  if (!response.ok) {
    return null;
  }

  const body = (await response.json()) as InstallationTokenResponse;
  const accessToken = typeof body.token === "string" ? body.token : null;

  if (!accessToken) {
    return null;
  }

  const providerId = (config as GithubAppInstallationFlowConfig).providerId ?? "github";
  const expiresAt =
    typeof body.expires_at === "string" ? Date.parse(body.expires_at) : Number.NaN;

  return {
    providerId,
    connectionId: randomUUID(),
    connectionLabel:
      (config as GithubAppInstallationFlowConfig).connectionLabel ??
      `GitHub App installation ${installationId}`,
    accountIdentity: {
      providerUserId: `app-${appId}`,
    },
    accessToken,
    scopes: [],
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined,
  };
}
