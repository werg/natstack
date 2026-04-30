import { credentials, oauth, openExternal, workspace } from "@workspace/runtime";
import type {
  BeginOAuthPkceCredentialResult,
  CompleteOAuthPkceCredentialRequest,
  StoredCredentialSummary,
  WorkspaceConfig,
} from "@workspace/runtime";

const GOOGLE_PROVIDER_ID = "google-workspace";
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
] as const;
const GOOGLE_AUDIENCE_ORIGINS = new Set([
  "https://gmail.googleapis.com",
  "https://www.googleapis.com",
]);

type RuntimeCredentials = typeof credentials;

export type GoogleOnboardingStage =
  | "needs-setup"
  | "ready-to-connect"
  | "connected"
  | "verified"
  | "error";

export interface GoogleConnectionCheck {
  connected: boolean;
  connectionId?: string;
  credentialId?: string;
  email?: string;
  error?: string;
}

export interface GoogleConnectionResult {
  success: boolean;
  connectionId?: string;
  credentialId?: string;
  email?: string;
  error?: string;
}

export interface GoogleVerificationResult {
  valid: boolean;
  email?: string;
  scopes?: string[];
  credentialId?: string;
  error?: string;
}

export interface GoogleOnboardingStatus {
  stage: GoogleOnboardingStage;
  configured: boolean;
  readyToConnect: boolean;
  connected: boolean;
  connectionId?: string;
  credentialId?: string;
  email?: string;
  credentials: StoredCredentialSummary[];
  verification?: GoogleVerificationResult;
  nextActions: string[];
  warnings: string[];
  error?: string;
}

export interface GoogleOnboardingStatusOptions {
  verify?: boolean;
}

export interface ConnectGoogleOptions {
  clientId?: string;
  scopes?: string[];
}

function getDefaultScopes(scopes?: string[]): string[] {
  return scopes?.length ? scopes : [...GOOGLE_SCOPES];
}

function getCredentialRuntime(): RuntimeCredentials {
  const api = credentials as Partial<RuntimeCredentials> | undefined;
  if (!api) {
    throw new Error(
      "NatStack credential runtime is unavailable: @workspace/runtime did not export credentials."
    );
  }
  for (const method of [
    "beginCreateWithOAuthPkce",
    "completeCreateWithOAuthPkce",
    "listStoredCredentials",
    "revokeCredential",
    "fetch",
  ] as const) {
    if (typeof api[method] !== "function") {
      throw new Error(
        `NatStack credential runtime is unavailable: credentials.${method} is missing.`
      );
    }
  }
  return api as RuntimeCredentials;
}

function normalizeCredentialRuntimeError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  const runtimeUnavailable =
    message.includes("undefined (reading 'call')") ||
    message.includes("Panel credentials have not been initialized") ||
    message.includes("NatStack transport bridge is not available") ||
    message.includes("__natstackTransport") ||
    message.includes("credential runtime is unavailable");
  if (!runtimeUnavailable) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(
    "NatStack credential runtime is unavailable in this context. " +
      "Google Workspace helpers must run in a NatStack panel/eval/worker runtime with credentials initialized. " +
      `Original error: ${message}`
  );
}

async function withCredentialRuntime<T>(fn: (api: RuntimeCredentials) => Promise<T>): Promise<T> {
  try {
    return await fn(getCredentialRuntime());
  } catch (error) {
    throw normalizeCredentialRuntimeError(error);
  }
}

function isGoogleCredential(credential: StoredCredentialSummary): boolean {
  if (credential.revokedAt) return false;
  if (credential.metadata?.["providerId"] === GOOGLE_PROVIDER_ID) return true;
  return credential.audience.some((audience) => {
    try {
      return GOOGLE_AUDIENCE_ORIGINS.has(new URL(audience.url).origin);
    } catch {
      return false;
    }
  });
}

async function getConfiguredClientId(): Promise<string | undefined> {
  const config = (await workspace.getConfig()) as WorkspaceConfig;
  return (
    config.credentials?.providers?.[GOOGLE_PROVIDER_ID]?.clientId ??
    config.credentials?.providers?.["google"]?.clientId
  );
}

function getPrimaryCredential(
  credentials: StoredCredentialSummary[]
): StoredCredentialSummary | undefined {
  return credentials.find((credential) => !credential.revokedAt);
}

function getCredentialEmail(credential: StoredCredentialSummary | undefined): string | undefined {
  return credential?.accountIdentity?.email;
}

function getNextActions(
  status: Pick<GoogleOnboardingStatus, "stage" | "connected" | "configured">
): string[] {
  switch (status.stage) {
    case "needs-setup":
      return [
        "Render the Google Workspace setup workflow from SETUP.md.",
        "Save a Desktop app OAuth client_id under credentials.providers.google-workspace.clientId.",
      ];
    case "ready-to-connect":
      return ["Run connectGoogle() to create the Google Workspace credential."];
    case "connected":
      return ["Run verifyGoogleConnection(connectionId) before declaring onboarding complete."];
    case "verified":
      return ["Continue onboarding with the verified Google Workspace credential."];
    case "error":
      return [
        "Fix the reported runtime or credential setup error, then rerun getGoogleOnboardingStatus().",
      ];
  }
}

function buildStatus(input: {
  configured: boolean;
  credentials: StoredCredentialSummary[];
  verification?: GoogleVerificationResult;
  warnings?: string[];
}): GoogleOnboardingStatus {
  const primary = getPrimaryCredential(input.credentials);
  const connected = !!primary;
  const verified = input.verification?.valid === true;
  const stage: GoogleOnboardingStage = verified
    ? "verified"
    : connected
      ? "connected"
      : input.configured
        ? "ready-to-connect"
        : "needs-setup";
  const status: GoogleOnboardingStatus = {
    stage,
    configured: input.configured,
    readyToConnect: input.configured && !connected,
    connected,
    connectionId: primary?.id,
    credentialId: primary?.id,
    email: input.verification?.email ?? getCredentialEmail(primary),
    credentials: input.credentials,
    verification: input.verification,
    nextActions: [],
    warnings: input.warnings ?? [],
  };
  status.nextActions = getNextActions(status);
  return status;
}

export async function beginGoogleCredentialCreation(opts: {
  clientId: string;
  redirectUri: string;
  scopes?: string[];
}): Promise<BeginOAuthPkceCredentialResult> {
  return withCredentialRuntime((api) =>
    api.beginCreateWithOAuthPkce({
      oauth: {
        authorizeUrl: GOOGLE_AUTH_URL,
        tokenUrl: GOOGLE_TOKEN_URL,
        clientId: opts.clientId,
        scopes: getDefaultScopes(opts.scopes),
        extraAuthorizeParams: {
          access_type: "offline",
          prompt: "consent",
        },
      },
      credential: {
        label: "Google Workspace",
        audience: [
          { url: "https://gmail.googleapis.com/", match: "origin" },
          { url: "https://www.googleapis.com/", match: "origin" },
        ],
        injection: {
          type: "header",
          name: "authorization",
          valueTemplate: "Bearer {token}",
        },
        scopes: getDefaultScopes(opts.scopes),
        metadata: {
          providerId: GOOGLE_PROVIDER_ID,
        },
      },
      redirectUri: opts.redirectUri,
    })
  );
}

export async function completeGoogleCredentialCreation(
  params: CompleteOAuthPkceCredentialRequest
): Promise<StoredCredentialSummary> {
  return withCredentialRuntime((api) => api.completeCreateWithOAuthPkce(params));
}

export async function listGoogleCredentials(): Promise<StoredCredentialSummary[]> {
  return withCredentialRuntime(async (api) => {
    const all = await api.listStoredCredentials();
    return all.filter(isGoogleCredential);
  });
}

export async function revokeGoogleCredential(credentialId: string): Promise<void> {
  await withCredentialRuntime((api) => api.revokeCredential(credentialId));
}

export async function verifyGoogleCredential(
  credentialId: string
): Promise<GoogleVerificationResult> {
  return withCredentialRuntime(async (api) => {
    const response = await api.fetch(
      "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
      undefined,
      { credentialId }
    );
    if (!response.ok) {
      return { valid: false, credentialId, error: `${response.status} ${response.statusText}` };
    }
    const body = (await response.json()) as { email?: string };
    const credential = (await listGoogleCredentials()).find(
      (candidate) => candidate.id === credentialId
    );
    return {
      valid: true,
      credentialId,
      email: body.email ?? getCredentialEmail(credential),
      scopes: credential?.scopes,
    };
  });
}

export async function verifyGoogleConnection(
  connectionId: string
): Promise<GoogleVerificationResult> {
  return verifyGoogleCredential(connectionId);
}

export async function checkGoogleConnection(): Promise<GoogleConnectionCheck> {
  const status = await getGoogleOnboardingStatus();
  return {
    connected: status.connected,
    connectionId: status.connectionId,
    credentialId: status.credentialId,
    email: status.email,
    error: status.error,
  };
}

export async function getGoogleOnboardingStatus(
  opts: GoogleOnboardingStatusOptions = {}
): Promise<GoogleOnboardingStatus> {
  const warnings: string[] = [];
  try {
    let configured = false;
    try {
      configured = !!(await getConfiguredClientId());
    } catch (error) {
      warnings.push(
        `Could not read workspace credential provider config: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const googleCredentials = await listGoogleCredentials();
    const primary = getPrimaryCredential(googleCredentials);
    const verification =
      opts.verify && primary ? await verifyGoogleCredential(primary.id) : undefined;

    if (verification && !verification.valid && verification.error) {
      warnings.push(`Google Workspace verification failed: ${verification.error}`);
    }

    return buildStatus({
      configured,
      credentials: googleCredentials,
      verification,
      warnings,
    });
  } catch (error) {
    const normalized = normalizeCredentialRuntimeError(error);
    const status: GoogleOnboardingStatus = {
      stage: "error",
      configured: false,
      readyToConnect: false,
      connected: false,
      credentials: [],
      nextActions: [],
      warnings,
      error: normalized.message,
    };
    status.nextActions = getNextActions(status);
    return status;
  }
}

export async function connectGoogle(
  opts: ConnectGoogleOptions = {}
): Promise<GoogleConnectionResult> {
  let callback: Awaited<ReturnType<typeof oauth.createLoopbackCallback>> | null = null;
  try {
    const clientId = opts.clientId ?? (await getConfiguredClientId());
    if (!clientId) {
      return {
        success: false,
        error:
          "Google Workspace OAuth client_id is not configured. " +
          "Save a Desktop app client_id under credentials.providers.google-workspace.clientId before calling connectGoogle().",
      };
    }

    callback = await oauth.createLoopbackCallback();
    const begin = await beginGoogleCredentialCreation({
      clientId,
      redirectUri: callback.redirectUri,
      scopes: opts.scopes,
    });
    await openExternal(begin.authorizeUrl, { expectedRedirectUri: callback.redirectUri });
    const callbackResult = await callback.waitForCallback();
    const stored = await completeGoogleCredentialCreation({
      nonce: begin.nonce,
      code: callbackResult.code,
      state: callbackResult.state,
    });
    const verification = await verifyGoogleCredential(stored.id);
    return {
      success: verification.valid,
      connectionId: stored.id,
      credentialId: stored.id,
      email: verification.email ?? getCredentialEmail(stored),
      error: verification.valid ? undefined : verification.error,
    };
  } catch (error) {
    const normalized = normalizeCredentialRuntimeError(error);
    return { success: false, error: normalized.message };
  } finally {
    await callback?.close().catch(() => {});
  }
}

export function formatGoogleOnboardingStatus(status: GoogleOnboardingStatus): string {
  const lines = [
    `Google Workspace stage: ${status.stage}`,
    `configured=${status.configured}`,
    `readyToConnect=${status.readyToConnect}`,
    `connected=${status.connected}`,
  ];
  if (status.connectionId) lines.push(`connectionId=${status.connectionId}`);
  if (status.email) lines.push(`email=${status.email}`);
  if (status.verification)
    lines.push(`verification=${status.verification.valid ? "valid" : "invalid"}`);
  if (status.error) lines.push(`error=${status.error}`);
  if (status.warnings.length) lines.push(`warnings=${status.warnings.join("; ")}`);
  if (status.nextActions.length) lines.push(`nextActions=${status.nextActions.join(" | ")}`);
  return lines.join("\n");
}
