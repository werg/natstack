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
      name: "app source push unit batch",
      approval: {
        ...base,
        kind: "unit-batch",
        trigger: "source-push",
        title: "Shell app source push",
        description: "Accepting this push updates trusted workspace app code.",
        units: [{
          unitKind: "app",
          unitName: "@workspace-apps/shell",
          displayName: "Shell",
          version: "1.0.0",
          target: "electron",
          source: { kind: "internal-git", repo: "apps/shell", ref: "main" },
          ev: "ev-shell",
          capabilities: ["notifications"],
        }],
        configWrite: null,
      },
      category: "App source",
      title: "Shell app source push",
      summaryIncludes: "trusted workspace app code",
      warning: "Approving allows these workspace apps to run in the app host.",
      detailsOpen: true,
    },
    {
      name: "extension management unit batch",
      approval: {
        ...base,
        kind: "unit-batch",
        trigger: "management",
        title: "Reload extension",
        description: "Allow panel panel-1 to reload @workspace-extensions/acme.",
        units: [{
          unitKind: "extension",
          unitName: "@workspace-extensions/acme",
          displayName: "Acme",
          version: "1.2.3",
          target: null,
          source: { kind: "internal-git", repo: "extensions/acme", ref: "main" },
          ev: "ev-acme",
          capabilities: ["node:fs", "node:child_process"],
        }],
        configWrite: null,
      },
      category: "Extension management",
      title: "Reload extension",
      summaryIncludes: "reload @workspace-extensions/acme",
      warning:
        "Approving runs native code with filesystem, network, and process access.",
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
        promptOptions: "choices",
        options: [{ value: "allow", label: "Allow", tone: "primary" }],
      },
      category: "Worker request",
      title: "Worker requests your decision",
      summaryIncludes: "team-x:foo",
    },
    {
      name: "app userland",
      approval: {
        ...base,
        callerId: "app:apps/shell:device-1",
        callerKind: "app",
        repoPath: "apps/shell",
        kind: "userland",
        subject: { id: "native:notifications", label: "Notifications" },
        title: "Allow notifications?",
        summary: "The shell app is requesting notification access.",
        promptOptions: "choices",
        options: [{ value: "allow", label: "Allow", tone: "primary" }],
      },
      category: "App request",
      title: "App requests your decision",
      summaryIncludes: "native:notifications",
    },
  ];

  const requesterLabel = (approval: PendingApproval): string => {
    switch (approval.callerKind) {
      case "app":
        return "App";
      case "worker":
        return "Worker";
      case "do":
        return "DO";
      default:
        return "Panel";
    }
  };

  it.each(fixtures)(
    "formats $name copy",
    ({ approval, category, title, summaryIncludes, warning, detailsOpen }) => {
      const copy = getApprovalCopy(approval, requesterLabel(approval));

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
