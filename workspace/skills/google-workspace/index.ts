import { credentials } from "@workspace/runtime";
import type {
  BeginOAuthPkceCredentialResult,
  CompleteOAuthPkceCredentialRequest,
  StoredCredentialSummary,
} from "@workspace/runtime";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_SCOPE = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
].join(" ");

export async function beginGoogleCredentialCreation(opts: {
  clientId: string;
  redirectUri: string;
  scopes?: string[];
}): Promise<BeginOAuthPkceCredentialResult> {
  return credentials.beginCreateWithOAuthPkce({
    oauth: {
      authorizeUrl: GOOGLE_AUTH_URL,
      tokenUrl: GOOGLE_TOKEN_URL,
      clientId: opts.clientId,
      scopes: opts.scopes ?? [GOOGLE_SCOPE],
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
      scopes: opts.scopes ?? [GOOGLE_SCOPE],
    },
    redirectUri: opts.redirectUri,
  });
}

export async function completeGoogleCredentialCreation(
  params: CompleteOAuthPkceCredentialRequest,
): Promise<StoredCredentialSummary> {
  return credentials.completeCreateWithOAuthPkce(params);
}

export async function listGoogleCredentials(): Promise<StoredCredentialSummary[]> {
  const all = await credentials.listStoredCredentials();
  return all.filter((credential) =>
    !credential.revokedAt &&
    credential.audience.some((audience) => {
      const origin = new URL(audience.url).origin;
      return origin === "https://gmail.googleapis.com" || origin === "https://www.googleapis.com";
    })
  );
}

export async function revokeGoogleCredential(credentialId: string): Promise<void> {
  await credentials.revokeCredential(credentialId);
}

export async function verifyGoogleCredential(credentialId: string): Promise<{
  valid: boolean;
  email?: string;
  error?: string;
}> {
  const response = await credentials.fetch(
    "https://www.googleapis.com/oauth2/v1/userinfo?alt=json",
    undefined,
    { credentialId },
  );
  if (!response.ok) {
    return { valid: false, error: `${response.status} ${response.statusText}` };
  }
  const body = await response.json() as { email?: string };
  return { valid: true, email: body.email };
}
