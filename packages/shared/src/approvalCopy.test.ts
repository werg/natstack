import type { PendingApproval } from "./approvals.js";
import {
  formatAccount,
  formatGitRemoteSummary,
  formatInjection,
  formatServiceName,
  getApprovalCategoryLabel,
  getApprovalCopy,
  getStandardActionCopy,
  originForUrl,
  shouldOpenApprovalDetails,
} from "./approvalCopy.js";

const base = {
  approvalId: "approval-1",
  callerId: "worker-abcdef123456",
  callerKind: "worker",
  repoPath: "/projects/foo",
  effectiveVersion: "v1",
  requestedAt: 1,
} as const;

describe("approvalCopy", () => {
  const fixtures: Array<{
    name: string;
    approval: PendingApproval;
    category: string;
    title: string;
    summaryIncludes: string;
    warning?: string;
    detailsOpen?: boolean;
  }> = [
    {
      name: "capability",
      approval: {
        ...base,
        kind: "capability",
        capability: "open-url",
        title: "Open URL",
        resource: {
          type: "url",
          label: "URL",
          value: "https://github.com/foo/bar",
        },
        details: [{ label: "URL", value: "https://github.com/foo/bar" }],
      },
      category: "Browser action",
      title: "Open external site",
      summaryIncludes: "github.com/foo/...",
    },
    {
      name: "credential OAuth",
      approval: {
        ...base,
        kind: "credential",
        credentialId: "cred-google",
        credentialLabel: "Google Calendar",
        audience: [{ match: "origin", url: "https://calendar.google.com/" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {{token}}" },
        accountIdentity: { email: "me@example.com", providerUserId: "user-1" },
        scopes: ["calendar.readonly"],
        oauthAuthorizeOrigin: "https://accounts.google.com",
        oauthTokenOrigin: "https://oauth2.googleapis.com",
      },
      category: "Connection request",
      title: "Connect service",
      summaryIncludes: "connect Google Calendar",
    },
    {
      name: "credential git-write",
      approval: {
        ...base,
        kind: "credential",
        credentialId: "cred-git",
        credentialLabel: "GitHub PAT",
        audience: [{ match: "origin", url: "https://github.com/" }],
        injection: {
          type: "basic-auth",
          usernameTemplate: "x-access-token",
          passwordTemplate: "{{token}}",
        },
        accountIdentity: { username: "octo", providerUserId: "octo" },
        scopes: ["repo"],
        credentialUse: "git-http",
        gitOperation: {
          action: "write",
          label: "push commits",
          remote: "https://github.com/acme/project.git",
          service: "github",
        },
      },
      category: "Git write",
      title: "Push to remote",
      summaryIncludes: "github.com/acme/project",
    },
    {
      name: "client-config",
      approval: {
        ...base,
        kind: "client-config",
        configId: "google-calendar",
        authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
        tokenUrl: "https://oauth2.googleapis.com/token",
        title: "Google Calendar",
        fields: [
          { name: "clientId", label: "Client ID", type: "text", required: true },
          { name: "clientSecret", label: "Client Secret", type: "secret", required: true },
        ],
      },
      category: "Service setup",
      title: "Configure service",
      summaryIncludes: "Save OAuth client settings",
    },
    {
      name: "credential-input",
      approval: {
        ...base,
        kind: "credential-input",
        title: "Add API key",
        credentialLabel: "Acme API",
        audience: [{ match: "path-prefix", url: "https://api.acme.test/v1/projects" }],
        injection: { type: "query-param", name: "api_key" },
        accountIdentity: { providerUserId: "acme-user" },
        scopes: ["projects.read"],
        fields: [{ name: "apiKey", label: "API Key", type: "secret", required: true }],
      },
      category: "Service setup",
      title: "Add service",
      summaryIncludes: "api.acme.test/v1/...",
    },
    {
      name: "OAuth domain-mismatch",
      approval: {
        ...base,
        kind: "credential",
        credentialId: "cred-mismatch",
        credentialLabel: "Google Calendar",
        audience: [{ match: "origin", url: "https://calendar.google.com/" }],
        injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {{token}}" },
        accountIdentity: { email: "me@example.com", providerUserId: "user-1" },
        scopes: ["calendar.readonly"],
        oauthAuthorizeOrigin: "https://accounts.google.com",
        oauthTokenOrigin: "https://oauth2.googleapis.com",
        oauthAudienceDomainMismatch: true,
      },
      category: "Connection request",
      title: "Connect service",
      summaryIncludes: "calendar.google.com",
      warning: "The sign-in domain differs from the service domain.",
    },
    {
      name: "extension source push",
      approval: {
        ...base,
        kind: "extension",
        action: "source-push",
        extensionName: "@workspace-extensions/acme",
        version: "1.2.3",
        source: { kind: "internal-git", repo: "extensions/acme", ref: "main" },
        title: "Acme source push",
        description: "Accepting this push updates trusted native extension code.",
        previousEv: "ev-old",
        ev: "ev-new",
        previousSha: "abc123",
        sha: "def456",
        capabilities: ["node:fs", "node:child_process"],
      },
      category: "Extension source",
      title: "Acme source push",
      summaryIncludes: "update trusted source",
      warning:
        "Approving this can run Node extension code with filesystem, network, and process access.",
      detailsOpen: true,
    },
    {
      name: "userland",
      approval: {
        ...base,
        kind: "userland",
        subject: { id: "team-x:foo", label: "Foo" },
        title: "Allow foo?",
        summary: "Team X is requesting access to foo.",
        options: [{ value: "allow", label: "Allow", tone: "primary" }],
      },
      category: "Worker request",
      title: "Worker requests your decision",
      summaryIncludes: "team-x:foo",
    },
  ];

  it.each(fixtures)(
    "formats $name copy",
    ({ approval, category, title, summaryIncludes, warning, detailsOpen }) => {
      const copy = getApprovalCopy(approval, approval.callerKind === "worker" ? "Worker" : "Panel");

      expect(getApprovalCategoryLabel(approval)).toBe(category);
      expect(copy.title).toBe(title);
      expect(copy.summary).toContain(summaryIncludes);
      expect(copy.warning).toBe(warning);
      expect(shouldOpenApprovalDetails(approval)).toBe(detailsOpen ?? false);
    }
  );

  it("formats standard action labels by approval subtype", () => {
    const [capability, oauth, gitWrite] = fixtures.map((fixture) => fixture.approval);

    expect(
      getStandardActionCopy(oauth as Extract<PendingApproval, { kind: "credential" }>).once.label
    ).toBe("Connect once");
    expect(
      getStandardActionCopy(gitWrite as Extract<PendingApproval, { kind: "credential" }>).once.label
    ).toBe("Push once");
    expect(
      getStandardActionCopy(capability as Extract<PendingApproval, { kind: "capability" }>).once
        .label
    ).toBe("Open once");
    expect(
      getStandardActionCopy(
        fixtures.find((fixture) => fixture.name === "extension source push")!
          .approval as Extract<PendingApproval, { kind: "extension" }>
      ).session.label
    ).toBe("Allow dev session");
  });

  it("formats low-level detail helpers", () => {
    const credential = fixtures[1]?.approval as Extract<PendingApproval, { kind: "credential" }>;
    const credentialInput = fixtures[4]?.approval as Extract<
      PendingApproval,
      { kind: "credential-input" }
    >;

    expect(formatAccount(credential)).toBe("me@example.com");
    expect(formatInjection(credential)).toBe("header Authorization");
    expect(formatInjection(credentialInput)).toBe("query api_key");
    expect(formatGitRemoteSummary("https://github.com/acme/project.git")).toBe(
      "github.com/acme/project"
    );
    expect(originForUrl("https://accounts.google.com/o/oauth2/v2/auth")).toBe(
      "https://accounts.google.com"
    );
    expect(formatServiceName("google-calendar")).toBe("Google Calendar");
  });
});
