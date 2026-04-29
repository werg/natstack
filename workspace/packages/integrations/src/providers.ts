export interface UrlCredentialDescriptor {
  id: string;
  displayName: string;
  credentialId?: string;
  audiences: Array<{
    url: string;
    match: "origin" | "path-prefix" | "exact";
  }>;
}

export const githubCredential: UrlCredentialDescriptor = {
  id: "github",
  displayName: "GitHub",
  audiences: [
    { url: "https://api.github.com/", match: "origin" },
    { url: "https://uploads.github.com/", match: "origin" },
  ],
};

export const googleWorkspaceCredential: UrlCredentialDescriptor = {
  id: "google-workspace",
  displayName: "Google Workspace",
  audiences: [
    { url: "https://gmail.googleapis.com/", match: "origin" },
    { url: "https://www.googleapis.com/", match: "origin" },
  ],
};

export const providers = {
  githubCredential,
  googleWorkspaceCredential,
};
