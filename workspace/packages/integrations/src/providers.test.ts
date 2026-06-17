import { describe, expect, it } from "vitest";
import {
  GOOGLE_WORKSPACE_BROAD_SCOPES,
  githubBindings,
  googleWorkspaceCredential,
} from "./providers.js";

describe("provider credential catalogs", () => {
  it("keeps Google Workspace staged within the credential binding limit", () => {
    expect(googleWorkspaceCredential.bindings).toHaveLength(8);
    expect(googleWorkspaceCredential.bindings.map((binding) => binding.id)).toEqual([
      "google-gmail",
      "google-calendar",
      "google-drive",
      "google-docs",
      "google-sheets",
      "google-slides",
      "google-people",
      "google-identity",
    ]);
    expect(GOOGLE_WORKSPACE_BROAD_SCOPES).toEqual(expect.arrayContaining([
      "https://www.googleapis.com/auth/gmail.modify",
      "https://www.googleapis.com/auth/calendar",
      "https://www.googleapis.com/auth/drive",
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/spreadsheets",
      "https://www.googleapis.com/auth/presentations",
    ]));
  });

  it("scopes GitHub API grants to the requested repository", () => {
    expect(githubBindings.repos).toMatchObject({
      id: "github-repos",
      audience: [{ url: "https://api.github.com/repos/", match: "path-prefix" }],
      grantResource: { type: "url-path-prefix", segmentCount: 3 },
    });
  });
});
