import { createHash, createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { Credential, FlowConfig } from "../types.js";

export type FlowRunner = (config: FlowConfig, providerId?: string) => Promise<Credential | null>;

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_TOKEN_LIFETIME_SECONDS = 3600;
const DEFAULT_SERVICE_ACCOUNT_PATH = path.join(homedir(), ".natstack", "service-account.json");

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function getString(record: JsonObject, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function getStringArray(record: JsonObject, key: string): string[] {
  const value = record[key];

  if (typeof value === "string" && value.trim().length > 0) {
    return value
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
}

function getNumber(record: JsonObject, key: string): number | undefined {
  const value = record[key];

  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsedValue = Number(value);
    return Number.isFinite(parsedValue) ? parsedValue : undefined;
  }

  return undefined;
}

function encodeBase64Url(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function getServiceAccountPath(): string {
  const configuredPath = process.env["NATSTACK_SERVICE_ACCOUNT_PATH"];

  if (!configuredPath || configuredPath.trim().length === 0) {
    return DEFAULT_SERVICE_ACCOUNT_PATH;
  }

  if (configuredPath === "~") {
    return homedir();
  }

  if (configuredPath.startsWith("~/")) {
    return path.join(homedir(), configuredPath.slice(2));
  }

  return configuredPath;
}

function getRequestedScopes(config: FlowConfig, credentialBlob: JsonObject): string[] {
  const configWithScopes = config as FlowConfig & { scopes?: unknown };

  if (Array.isArray(configWithScopes.scopes)) {
    const scopes = configWithScopes.scopes.filter(
      (scope): scope is string => typeof scope === "string" && scope.length > 0,
    );

    if (scopes.length > 0) {
      return scopes;
    }
  }

  const fileScopes = getStringArray(credentialBlob, "scopes");
  return fileScopes.length > 0 ? fileScopes : getStringArray(credentialBlob, "scope");
}

function inferProviderId(config: FlowConfig, credentialBlob: JsonObject, isGoogleServiceAccount: boolean): string {
  if (isGoogleServiceAccount) {
    return "google";
  }

  const explicitProviderId =
    getString(credentialBlob, "providerId") ??
    getString(credentialBlob, "provider_id") ??
    getString(credentialBlob, "provider");

  if (explicitProviderId) {
    return explicitProviderId;
  }

  const accountType = getString(credentialBlob, "type")?.toLowerCase();

  if (accountType?.includes("aws")) {
    return "aws";
  }

  if (accountType?.includes("azure")) {
    return "azure";
  }

  if (accountType?.includes("gcp") || accountType?.includes("google")) {
    return "google";
  }

  return config.type;
}

function buildAccountIdentity(providerId: string, credentialBlob: JsonObject): Credential["accountIdentity"] {
  const email = getString(credentialBlob, "client_email") ?? getString(credentialBlob, "email");
  const username =
    getString(credentialBlob, "username") ??
    getString(credentialBlob, "user") ??
    getString(credentialBlob, "access_key_id");
  const workspaceName =
    getString(credentialBlob, "workspaceName") ??
    getString(credentialBlob, "workspace_name") ??
    getString(credentialBlob, "account_name") ??
    getString(credentialBlob, "project_id");

  const providerUserId =
    getString(credentialBlob, "providerUserId") ??
    getString(credentialBlob, "provider_user_id") ??
    getString(credentialBlob, "client_email") ??
    getString(credentialBlob, "client_id") ??
    getString(credentialBlob, "private_key_id") ??
    getString(credentialBlob, "access_key_id") ??
    getString(credentialBlob, "account_id") ??
    email ??
    username ??
    workspaceName ??
    providerId;

  return {
    providerUserId,
    ...(email ? { email } : {}),
    ...(username ? { username } : {}),
    ...(workspaceName ? { workspaceName } : {}),
  };
}

function buildConnectionId(providerId: string, accountIdentity: Credential["accountIdentity"]): string {
  const hashInput = [
    providerId,
    accountIdentity.providerUserId,
    accountIdentity.email ?? "",
    accountIdentity.username ?? "",
    accountIdentity.workspaceName ?? "",
  ].join(":");

  return createHash("sha256").update(hashInput).digest("hex").slice(0, 24);
}

function buildConnectionLabel(
  providerId: string,
  accountIdentity: Credential["accountIdentity"],
  credentialBlob: JsonObject,
): string {
  const explicitLabel =
    getString(credentialBlob, "connectionLabel") ??
    getString(credentialBlob, "connection_label") ??
    getString(credentialBlob, "name");

  if (explicitLabel) {
    return explicitLabel;
  }

  const subject =
    accountIdentity.email ??
    accountIdentity.username ??
    accountIdentity.workspaceName ??
    accountIdentity.providerUserId;

  return `${providerId} service account (${subject})`;
}

function createGoogleJwtAssertion(
  clientEmail: string,
  privateKey: string,
  scopes: string[],
  issuedAtSeconds: number,
): string {
  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const claims = {
    iss: clientEmail,
    scope: scopes.join(" "),
    aud: GOOGLE_TOKEN_URL,
    iat: issuedAtSeconds,
    exp: issuedAtSeconds + GOOGLE_TOKEN_LIFETIME_SECONDS,
  };

  const unsignedToken = `${encodeBase64Url(JSON.stringify(header))}.${encodeBase64Url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();

  const signature = signer.sign(privateKey, "base64url");
  return `${unsignedToken}.${signature}`;
}

async function exchangeGoogleServiceAccountToken(
  clientEmail: string,
  privateKey: string,
  scopes: string[],
): Promise<{ accessToken: string; expiresAt: number }> {
  const issuedAtSeconds = Math.floor(Date.now() / 1000);
  const assertion = createGoogleJwtAssertion(clientEmail, privateKey, scopes, issuedAtSeconds);
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  });

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });

  const payload = (await response.json()) as unknown;

  if (!response.ok) {
    const errorDescription = isJsonObject(payload)
      ? getString(payload, "error_description") ?? getString(payload, "error")
      : undefined;

    throw new Error(
      errorDescription
        ? `Google service account token exchange failed: ${response.status} ${errorDescription}`
        : `Google service account token exchange failed with status ${response.status}`,
    );
  }

  if (!isJsonObject(payload)) {
    throw new TypeError("Google service account token exchange returned a non-object payload.");
  }

  const accessToken = getString(payload, "access_token");

  if (!accessToken) {
    throw new TypeError("Google service account token exchange response did not include access_token.");
  }

  const expiresIn = getNumber(payload, "expires_in") ?? GOOGLE_TOKEN_LIFETIME_SECONDS;

  return {
    accessToken,
    expiresAt: Date.now() + expiresIn * 1000,
  };
}

function getGenericServiceAccountToken(credentialBlob: JsonObject): string {
  const accessToken = getString(credentialBlob, "access_token") ?? getString(credentialBlob, "token");

  if (!accessToken) {
    throw new TypeError("Service account credential blob did not include token or access_token.");
  }

  return accessToken;
}

function getGenericExpiration(credentialBlob: JsonObject): number | undefined {
  const expiresAt = getNumber(credentialBlob, "expiresAt") ?? getNumber(credentialBlob, "expires_at");

  if (expiresAt !== undefined) {
    return expiresAt;
  }

  const expiresIn = getNumber(credentialBlob, "expires_in");
  return expiresIn !== undefined ? Date.now() + expiresIn * 1000 : undefined;
}

export async function serviceAccount(config: FlowConfig): Promise<Credential | null> {
  const credentialPath = getServiceAccountPath();
  let fileContents: string;

  try {
    fileContents = await readFile(credentialPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }

    throw error;
  }

  const parsedCredentialBlob = JSON.parse(fileContents) as unknown;

  if (!isJsonObject(parsedCredentialBlob)) {
    throw new TypeError("Service account credential file must contain a JSON object.");
  }

  const isGoogleServiceAccount = getString(parsedCredentialBlob, "type") === "service_account";
  const providerId = inferProviderId(config, parsedCredentialBlob, isGoogleServiceAccount);
  const accountIdentity = buildAccountIdentity(providerId, parsedCredentialBlob);
  const scopes = getRequestedScopes(config, parsedCredentialBlob);

  let accessToken: string;
  let expiresAt: number | undefined;

  if (isGoogleServiceAccount) {
    const clientEmail = getString(parsedCredentialBlob, "client_email");
    const privateKey = getString(parsedCredentialBlob, "private_key");

    if (!clientEmail || !privateKey) {
      throw new TypeError(
        "Google service account credential file must include client_email and private_key.",
      );
    }

    const googleToken = await exchangeGoogleServiceAccountToken(clientEmail, privateKey, scopes);
    accessToken = googleToken.accessToken;
    expiresAt = googleToken.expiresAt;
  } else {
    accessToken = getGenericServiceAccountToken(parsedCredentialBlob);
    expiresAt = getGenericExpiration(parsedCredentialBlob);
  }

  return {
    providerId,
    connectionId: buildConnectionId(providerId, accountIdentity),
    connectionLabel: buildConnectionLabel(providerId, accountIdentity, parsedCredentialBlob),
    accountIdentity,
    accessToken,
    refreshToken: getString(parsedCredentialBlob, "refresh_token") ?? getString(parsedCredentialBlob, "refreshToken"),
    scopes,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}
