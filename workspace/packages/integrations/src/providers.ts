import type {
  CredentialBinding,
  CredentialGrantResourceHint,
  CredentialInjection,
  UrlAudience,
} from "@workspace/runtime/credentials";

export interface UrlCredentialDescriptor {
  id: string;
  displayName: string;
  credentialId?: string;
  audiences: UrlAudience[];
  bindings: CredentialBinding[];
  upstreamScopes?: string[];
}

export interface BindingAudienceDescriptor {
  audiences: UrlAudience[];
  credentialId?: string;
  label?: string;
}

export const bearerTokenInjection: CredentialInjection = {
  type: "header",
  name: "authorization",
  valueTemplate: "Bearer {token}",
  stripIncoming: ["authorization"],
};

export const githubGitHttpInjection: CredentialInjection = {
  type: "basic-auth",
  usernameTemplate: "x-access-token",
  passwordTemplate: "{token}",
  stripIncoming: ["authorization"],
};

export const GOOGLE_WORKSPACE_BROAD_SCOPES = [
  "openid",
  "profile",
  "email",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.settings.basic",
  "https://www.googleapis.com/auth/calendar",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.metadata",
  "https://www.googleapis.com/auth/contacts",
  "https://www.googleapis.com/auth/contacts.other.readonly",
  "https://www.googleapis.com/auth/documents",
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/presentations",
] as const;

export const GITHUB_FINE_GRAINED_BROAD_PERMISSIONS = {
  metadata: "read",
  contents: "write",
  issues: "write",
  pull_requests: "write",
  actions: "write",
  workflows: "write",
  statuses: "write",
  deployments: "write",
  discussions: "write",
} as const;

export const GITHUB_CLASSIC_BROAD_SCOPES = [
  "repo",
  "workflow",
  "read:user",
  "user:email",
  "gist",
] as const;

const repoResource: CredentialGrantResourceHint = {
  type: "url-path-prefix",
  segmentCount: 3,
};

const googleFetch = (
  id: string,
  label: string,
  audience: UrlAudience[],
): CredentialBinding => ({
  id,
  label,
  use: "fetch",
  audience,
  injection: bearerTokenInjection,
});

export const googleWorkspaceBindings = {
  gmail: googleFetch("google-gmail", "Google Gmail", [
    { url: "https://gmail.googleapis.com/gmail/v1/users/me/", match: "path-prefix" },
    { url: "https://gmail.googleapis.com/batch/gmail/v1", match: "path-prefix" },
  ]),
  calendar: googleFetch("google-calendar", "Google Calendar", [
    { url: "https://www.googleapis.com/calendar/v3/", match: "path-prefix" },
  ]),
  drive: googleFetch("google-drive", "Google Drive", [
    { url: "https://www.googleapis.com/drive/v3/", match: "path-prefix" },
    { url: "https://www.googleapis.com/upload/drive/v3/", match: "path-prefix" },
  ]),
  docs: googleFetch("google-docs", "Google Docs", [
    { url: "https://docs.googleapis.com/v1/", match: "path-prefix" },
  ]),
  sheets: googleFetch("google-sheets", "Google Sheets", [
    { url: "https://sheets.googleapis.com/v4/", match: "path-prefix" },
  ]),
  slides: googleFetch("google-slides", "Google Slides", [
    { url: "https://slides.googleapis.com/v1/", match: "path-prefix" },
  ]),
  people: googleFetch("google-people", "Google People", [
    { url: "https://people.googleapis.com/v1/", match: "path-prefix" },
  ]),
  identity: googleFetch("google-identity", "Google identity", [
    { url: "https://www.googleapis.com/oauth2/v1/userinfo", match: "path-prefix" },
  ]),
} satisfies Record<string, CredentialBinding>;

export const googleWorkspaceCredential: UrlCredentialDescriptor = {
  id: "google-workspace",
  displayName: "Google Workspace",
  audiences: audiencesFromBindings(Object.values(googleWorkspaceBindings)),
  bindings: Object.values(googleWorkspaceBindings),
  upstreamScopes: [...GOOGLE_WORKSPACE_BROAD_SCOPES],
};

export const githubBindings = {
  user: {
    id: "github-user",
    label: "GitHub user and repository listing",
    use: "fetch",
    audience: [
      { url: "https://api.github.com/user", match: "path-prefix" },
      { url: "https://api.github.com/user/repos", match: "path-prefix" },
    ],
    injection: bearerTokenInjection,
    grantResource: { type: "url-path-prefix", segmentCount: 1 },
  },
  repos: {
    id: "github-repos",
    label: "GitHub repositories",
    use: "fetch",
    audience: [{ url: "https://api.github.com/repos/", match: "path-prefix" }],
    injection: bearerTokenInjection,
    grantResource: repoResource,
  },
  uploads: {
    id: "github-uploads",
    label: "GitHub release uploads",
    use: "fetch",
    audience: [{ url: "https://uploads.github.com/repos/", match: "path-prefix" }],
    injection: bearerTokenInjection,
    grantResource: repoResource,
  },
  gitHttp: {
    id: "github-git-http",
    label: "GitHub git over HTTPS",
    use: "git-http",
    audience: [{ url: "https://github.com/", match: "origin" }],
    injection: githubGitHttpInjection,
  },
} satisfies Record<string, CredentialBinding>;

export const githubCredential: UrlCredentialDescriptor = {
  id: "github",
  displayName: "GitHub",
  audiences: audiencesFromBindings([
    githubBindings.user,
    githubBindings.repos,
    githubBindings.uploads,
  ]),
  bindings: Object.values(githubBindings),
  upstreamScopes: [...GITHUB_CLASSIC_BROAD_SCOPES],
};

export const providers = {
  githubCredential,
  googleWorkspaceCredential,
};

export function audiencesFromBindings(bindings: readonly CredentialBinding[]): UrlAudience[] {
  const byKey = new Map<string, UrlAudience>();
  for (const binding of bindings) {
    for (const audience of binding.audience) {
      byKey.set(`${audience.match}\0${audience.url}`, audience);
    }
  }
  return Array.from(byKey.values());
}

export function bindingAudience(
  descriptor: UrlCredentialDescriptor,
  bindingId: string,
  opts: { credentialId?: string } = {},
): BindingAudienceDescriptor {
  const binding = descriptor.bindings.find((candidate) => candidate.id === bindingId);
  if (!binding) {
    throw new Error(`Unknown credential binding ${bindingId} for ${descriptor.id}`);
  }
  return {
    audiences: binding.audience,
    label: binding.label ?? descriptor.displayName,
    ...(opts.credentialId ? { credentialId: opts.credentialId } : {}),
  };
}
