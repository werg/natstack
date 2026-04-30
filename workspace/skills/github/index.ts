import { credentials, openExternal } from "@workspace/runtime";
import type { RequestCredentialInputRequest, StoredCredentialSummary } from "@workspace/runtime";

const GITHUB_PROVIDER_ID = "github";
const GITHUB_API_ORIGIN = "https://api.github.com";
const GITHUB_GIT_ORIGIN = "https://github.com";
const GITHUB_PAT_NEW_URL = "https://github.com/settings/personal-access-tokens/new";
const GITHUB_PAT_LIST_URL = "https://github.com/settings/personal-access-tokens";

type RuntimeCredentials = typeof credentials;

export type GitHubOnboardingStage = "needs-token" | "connected" | "verified" | "error";
export type GitHubCredentialMode = "api" | "git" | "api-and-git";
export type GitHubPermissionPreset =
  | "clone"
  | "pull"
  | "push"
  | "contents-read"
  | "contents-write"
  | "issues"
  | "pull-requests"
  | "actions-read"
  | "workflows";

export interface GitHubVerificationResult {
  valid: boolean;
  credentialId?: string;
  login?: string;
  userId?: number;
  error?: string;
}

export interface GitHubOnboardingStatus {
  stage: GitHubOnboardingStage;
  connected: boolean;
  verified: boolean;
  connectionId?: string;
  credentialId?: string;
  login?: string;
  credentials: StoredCredentialSummary[];
  verification?: GitHubVerificationResult;
  nextActions: string[];
  warnings: string[];
  error?: string;
}

export interface GitHubOnboardingStatusOptions {
  verify?: boolean;
}

export interface RequestGitHubTokenCredentialOptions {
  label?: string;
  mode?: GitHubCredentialMode;
  presets?: GitHubPermissionPreset[];
  scopes?: string[];
}

export const GITHUB_PERMISSION_PRESETS: Record<GitHubPermissionPreset, string[]> = {
  clone: ["metadata:read", "contents:read"],
  pull: ["metadata:read", "contents:read"],
  push: ["metadata:read", "contents:write"],
  "contents-read": ["metadata:read", "contents:read"],
  "contents-write": ["metadata:read", "contents:write"],
  issues: ["metadata:read", "issues:read", "issues:write"],
  "pull-requests": ["metadata:read", "pull_requests:read", "pull_requests:write"],
  "actions-read": ["metadata:read", "actions:read"],
  workflows: ["metadata:read", "contents:write", "workflows:write"],
};

function getCredentialRuntime(): RuntimeCredentials {
  const api = credentials as Partial<RuntimeCredentials> | undefined;
  if (!api) {
    throw new Error("NatStack credential runtime is unavailable: @workspace/runtime did not export credentials.");
  }
  for (const method of ["requestCredentialInput", "listStoredCredentials", "revokeCredential", "fetch"] as const) {
    if (typeof api[method] !== "function") {
      throw new Error(`NatStack credential runtime is unavailable: credentials.${method} is missing.`);
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
      "GitHub helpers must run in a NatStack panel/eval/worker runtime with credentials initialized. " +
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

function isGitHubCredential(credential: StoredCredentialSummary): boolean {
  if (credential.revokedAt) return false;
  if (credential.metadata?.["providerId"] === GITHUB_PROVIDER_ID) return true;
  return credential.audience.some((audience) => {
    try {
      const origin = new URL(audience.url).origin;
      return origin === GITHUB_API_ORIGIN;
    } catch {
      return false;
    }
  });
}

function getPrimaryCredential(credentials: StoredCredentialSummary[]): StoredCredentialSummary | undefined {
  return credentials.find((credential) => !credential.revokedAt);
}

function getDefaultPresets(mode: GitHubCredentialMode): GitHubPermissionPreset[] {
  switch (mode) {
    case "git":
      return ["clone", "pull", "push"];
    case "api-and-git":
      return ["clone", "push", "issues", "pull-requests"];
    case "api":
      return ["contents-read", "issues", "pull-requests"];
  }
}

function getPresetScopes(
  mode: GitHubCredentialMode,
  presets: GitHubPermissionPreset[] | undefined,
  scopes: string[] | undefined
): string[] {
  if (scopes?.length) return scopes;
  const selected: GitHubPermissionPreset[] = presets?.length ? presets : getDefaultPresets(mode);
  return [...new Set(selected.flatMap((preset) => GITHUB_PERMISSION_PRESETS[preset]))];
}

function buildCredentialRequest(opts: RequestGitHubTokenCredentialOptions = {}): RequestCredentialInputRequest {
  const mode = opts.mode ?? "api";
  const scopes = getPresetScopes(mode, opts.presets, opts.scopes);
  const defaultPresets = opts.presets?.length ? opts.presets : getDefaultPresets(mode);
  const fetchBinding = {
    id: "github-api",
    use: "fetch" as const,
    audience: [
      { url: `${GITHUB_API_ORIGIN}/`, match: "origin" as const },
    ],
    injection: {
      type: "header" as const,
      name: "authorization",
      valueTemplate: "Bearer {token}",
    },
  };
  const gitBinding = {
    id: "github-git",
    use: "git-http" as const,
    audience: [
      { url: `${GITHUB_GIT_ORIGIN}/`, match: "origin" as const },
    ],
    injection: {
      type: "basic-auth" as const,
      usernameTemplate: "x-access-token",
      passwordTemplate: "{token}",
    },
  };
  return {
    title: "Add GitHub",
    description: mode === "api"
      ? "Save a GitHub fine-grained personal access token for GitHub API calls."
      : "Save a GitHub fine-grained personal access token with repository contents permissions for direct git workflows.",
    credential: {
      label: opts.label ?? "GitHub",
      audience: fetchBinding.audience,
      injection: fetchBinding.injection,
      bindings: mode === "api" ? [fetchBinding] : [fetchBinding, gitBinding],
      accountIdentity: { providerUserId: "github-pat" },
      scopes,
      metadata: {
        providerId: GITHUB_PROVIDER_ID,
        providerKind: "fine-grained-pat",
        credentialMode: mode,
        permissionPresets: defaultPresets.join(","),
        ...(mode === "api" ? {} : { gitRemoteOrigin: `${GITHUB_GIT_ORIGIN}/` }),
      },
    },
    fields: [
      {
        name: "token",
        label: "Token",
        type: "secret",
        required: true,
        description: "Paste the generated fine-grained personal access token.",
      },
    ],
    material: {
      type: "bearer-token",
      tokenField: "token",
    },
  };
}

function getNextActions(status: Pick<GitHubOnboardingStatus, "stage">): string[] {
  switch (status.stage) {
    case "needs-token":
      return [
        "Render the GitHub setup workflow from SETUP.md.",
        "Generate a fine-grained personal access token in GitHub.",
        "Run requestGitHubTokenCredential() and enter the token in the trusted approval UI.",
      ];
    case "connected":
      return ["Run verifyGitHubCredential(connectionId) before declaring onboarding complete."];
    case "verified":
      return ["Continue onboarding with the verified GitHub credential."];
    case "error":
      return ["Fix the reported runtime or credential setup error, then rerun getGitHubOnboardingStatus()."];
  }
}

function buildStatus(input: {
  credentials: StoredCredentialSummary[];
  verification?: GitHubVerificationResult;
  warnings?: string[];
}): GitHubOnboardingStatus {
  const primary = getPrimaryCredential(input.credentials);
  const verified = input.verification?.valid === true;
  const stage: GitHubOnboardingStage = verified ? "verified" : primary ? "connected" : "needs-token";
  const status: GitHubOnboardingStatus = {
    stage,
    connected: !!primary,
    verified,
    connectionId: primary?.id,
    credentialId: primary?.id,
    login: input.verification?.login ?? primary?.accountIdentity?.username,
    credentials: input.credentials,
    verification: input.verification,
    nextActions: [],
    warnings: input.warnings ?? [],
  };
  status.nextActions = getNextActions(status);
  return status;
}

export async function openGitHubTokenSettings(): Promise<void> {
  await openExternal(GITHUB_PAT_NEW_URL);
}

export function getGitHubTokenSetupLinks() {
  return {
    newFineGrainedToken: GITHUB_PAT_NEW_URL,
    fineGrainedTokens: GITHUB_PAT_LIST_URL,
  };
}

export async function requestGitHubTokenCredential(
  opts: RequestGitHubTokenCredentialOptions = {}
): Promise<StoredCredentialSummary> {
  return withCredentialRuntime((api) => api.requestCredentialInput(buildCredentialRequest(opts)));
}

export async function listGitHubCredentials(): Promise<StoredCredentialSummary[]> {
  return withCredentialRuntime(async (api) => {
    const all = await api.listStoredCredentials();
    return all.filter(isGitHubCredential);
  });
}

export async function revokeGitHubCredential(credentialId: string): Promise<void> {
  await withCredentialRuntime((api) => api.revokeCredential(credentialId));
}

export async function verifyGitHubCredential(credentialId: string): Promise<GitHubVerificationResult> {
  return withCredentialRuntime(async (api) => {
    const response = await api.fetch(
      `${GITHUB_API_ORIGIN}/user`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
      { credentialId }
    );
    if (!response.ok) {
      return { valid: false, credentialId, error: `${response.status} ${response.statusText}` };
    }
    const body = (await response.json()) as { login?: string; id?: number };
    return {
      valid: true,
      credentialId,
      login: body.login,
      userId: body.id,
    };
  });
}

export async function verifyGitHubConnection(connectionId: string): Promise<GitHubVerificationResult> {
  return verifyGitHubCredential(connectionId);
}

export async function getGitHubOnboardingStatus(
  opts: GitHubOnboardingStatusOptions = {}
): Promise<GitHubOnboardingStatus> {
  const warnings: string[] = [];
  try {
    const githubCredentials = await listGitHubCredentials();
    const primary = getPrimaryCredential(githubCredentials);
    const verification = opts.verify && primary ? await verifyGitHubCredential(primary.id) : undefined;
    if (verification && !verification.valid && verification.error) {
      warnings.push(`GitHub verification failed: ${verification.error}`);
    }
    return buildStatus({ credentials: githubCredentials, verification, warnings });
  } catch (error) {
    const normalized = normalizeCredentialRuntimeError(error);
    const status: GitHubOnboardingStatus = {
      stage: "error",
      connected: false,
      verified: false,
      credentials: [],
      nextActions: [],
      warnings,
      error: normalized.message,
    };
    status.nextActions = getNextActions(status);
    return status;
  }
}

export async function checkGitHubConnection(): Promise<{
  connected: boolean;
  connectionId?: string;
  credentialId?: string;
  login?: string;
  error?: string;
}> {
  const status = await getGitHubOnboardingStatus();
  return {
    connected: status.connected,
    connectionId: status.connectionId,
    credentialId: status.credentialId,
    login: status.login,
    error: status.error,
  };
}

export async function verifyGitHubRepoAccess(
  owner: string,
  repo: string,
  credentialId?: string
): Promise<{ accessible: boolean; fullName?: string; private?: boolean; error?: string }> {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  return withCredentialRuntime(async (api) => {
    const response = await api.fetch(
      `${GITHUB_API_ORIGIN}/repos/${encodedOwner}/${encodedRepo}`,
      {
        headers: {
          accept: "application/vnd.github+json",
          "x-github-api-version": "2022-11-28",
        },
      },
      { credentialId }
    );
    if (!response.ok) {
      return { accessible: false, error: `${response.status} ${response.statusText}` };
    }
    const body = (await response.json()) as { full_name?: string; private?: boolean };
    return {
      accessible: true,
      fullName: body.full_name,
      private: body.private,
    };
  });
}

export function formatGitHubOnboardingStatus(status: GitHubOnboardingStatus): string {
  const lines = [
    `GitHub stage: ${status.stage}`,
    `connected=${status.connected}`,
    `verified=${status.verified}`,
  ];
  if (status.connectionId) lines.push(`connectionId=${status.connectionId}`);
  if (status.login) lines.push(`login=${status.login}`);
  if (status.error) lines.push(`error=${status.error}`);
  if (status.warnings.length) lines.push(`warnings=${status.warnings.join("; ")}`);
  if (status.nextActions.length) lines.push(`nextActions=${status.nextActions.join(" | ")}`);
  return lines.join("\n");
}
