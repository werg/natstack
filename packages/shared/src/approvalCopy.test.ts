import type { PendingApproval } from "./approvals.js";
import {
  formatAccount,
  formatGitRemoteSummary,
  formatInjection,
  formatServiceName,
  getApprovalAttribution,
  getApprovalCategoryLabel,
  getApprovalCopy,
  getStandardActionCopy,
  getUnitBatchActionCopy,
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
      title: "Open github.com/foo/...",
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
      title: "Connect Google Calendar",
      summaryIncludes: "Connects Google Calendar",
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
      title: "Push to github.com/acme/project",
      summaryIncludes: "github.com/acme/project",
    },
    {
      name: "credential repo binding",
      approval: {
        ...base,
        kind: "credential",
        credentialId: "cred-github",
        credentialLabel: "GitHub",
        audience: [{ match: "path-prefix", url: "https://api.github.com/repos/" }],
        injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
        accountIdentity: { username: "octo", providerUserId: "octo" },
        scopes: ["repo"],
        credentialUse: "fetch",
        bindingLabel: "GitHub repositories",
        grantResource: {
          bindingId: "github-repos",
          resource: "https://api.github.com/repos/acme/project/",
          action: "use",
        },
      },
      category: "Access request",
      title: "Use GitHub repositories",
      summaryIncludes: "GitHub repositories at github.com/acme/project",
    },
    {
      name: "workspace source change",
      approval: {
        ...base,
        kind: "capability",
        capability: "workspace-repo-write",
        grantResourceKey: "workspace-source-change:panels/spectrolite:main",
        title: "Update workspace source",
        resource: {
          type: "workspace-source",
          label: "Workspace source",
          value: "panels/spectrolite",
        },
      },
      category: "Workspace source",
      title: "Update panels/spectrolite",
      summaryIncludes: "Updates workspace source",
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
      title: "Set up Google Calendar",
      summaryIncludes: "Saves OAuth client settings",
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
      title: "Add Acme API",
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
      title: "Connect Google Calendar",
      summaryIncludes: "calendar.google.com",
      warning: "The sign-in domain differs from the service domain.",
    },
    {
      name: "app source change unit batch",
      approval: {
        ...base,
        kind: "unit-batch",
        trigger: "source-change",
        title: "Shell app source change",
        description: "Accepting this push updates trusted workspace app code.",
        units: [
          {
            unitKind: "app",
            unitName: "@workspace-apps/shell",
            displayName: "Shell",
            version: "1.0.0",
            target: "electron",
            source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
            ev: "ev-shell",
            capabilities: ["notifications"],
          },
        ],
        configWrite: null,
      },
      category: "App source",
      title: "Shell app source change",
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
        units: [
          {
            unitKind: "extension",
            unitName: "@workspace-extensions/acme",
            displayName: "Acme",
            version: "1.2.3",
            target: null,
            source: { kind: "workspace-repo", repo: "extensions/acme", ref: "main" },
            ev: "ev-acme",
            capabilities: ["node:fs", "node:child_process"],
          },
        ],
        configWrite: null,
      },
      category: "Extension management",
      title: "Reload extension",
      summaryIncludes: "reload @workspace-extensions/acme",
      warning: "Approving runs native code with filesystem, network, and process access.",
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
      title: "Allow foo?",
      summaryIncludes: "Team X is requesting access to foo.",
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
      title: "Allow notifications?",
      summaryIncludes: "notification access",
    },
    {
      name: "panel automate",
      approval: {
        ...base,
        kind: "capability",
        capability: "panel.automate",
        severity: "severe",
        title: "Drive privileged panel",
        resource: {
          type: "panel",
          label: "Panel",
          value: "Shell",
        },
      },
      category: "Panel automation",
      title: "Drive privileged panel",
      summaryIncludes: "Automates Shell",
      warning:
        "This target is privileged. Approving gives the requester control of a trusted shell panel.",
    },
    {
      name: "panel structural",
      approval: {
        ...base,
        kind: "capability",
        capability: "panel.structural",
        title: "Close panel",
        resource: {
          type: "panel",
          label: "Panel",
          value: "Child panel",
        },
      },
      category: "Panel change",
      title: "Close panel",
      summaryIncludes: "Changes Child panel",
    },
  ];

  it.each(fixtures)(
    "formats $name copy",
    ({ approval, category, title, summaryIncludes, warning, detailsOpen }) => {
      const copy = getApprovalCopy(approval);

      expect(getApprovalCategoryLabel(approval)).toBe(category);
      expect(copy.title).toBe(title);
      expect(copy.summary).toContain(summaryIncludes);
      expect(copy.warning).toBe(warning);
      expect(shouldOpenApprovalDetails(approval)).toBe(detailsOpen ?? false);
    }
  );

  it("derives semantic attribution chips, never raw ids", () => {
    const byName = (name: string) => fixtures.find((fixture) => fixture.name === name)!.approval;

    // Git uses the credential identity; non-oauth use names the audience.
    expect(getApprovalAttribution(byName("credential git-write"))).toEqual({
      relation: "using",
      target: "GitHub PAT",
    });
    // OAuth connect headlines the credential, so the chip surfaces the account.
    expect(getApprovalAttribution(byName("credential OAuth"))).toEqual({
      relation: "as",
      target: "me@example.com",
    });
    expect(getApprovalAttribution(byName("credential repo binding"))).toEqual({
      relation: "with",
      target: "GitHub repositories at github.com/acme/project",
    });
    // Capability/unit-batch requests have no secondary chip.
    expect(getApprovalAttribution(byName("capability"))).toEqual({});

    // Userland delegated through an extension surfaces the issuer label.
    const delegated: PendingApproval = {
      ...base,
      kind: "userland",
      issuer: { kind: "extension", id: "ext:gh", label: "GitHub extension" },
      subject: { id: "team-x:foo", label: "Foo" },
      title: "Allow foo?",
      promptOptions: "choices",
      options: [{ value: "allow", label: "Allow", tone: "primary" }],
    };
    expect(getApprovalAttribution(delegated)).toEqual({
      relation: "for",
      target: "GitHub extension",
    });
  });

  it("formats standard action labels by approval subtype", () => {
    const [capability, oauth, gitWrite] = fixtures.map((fixture) => fixture.approval);
    const severePanelAutomation = fixtures.find((fixture) => fixture.name === "panel automate")!
      .approval as Extract<PendingApproval, { kind: "capability" }>;
    const workspaceSourceChange = fixtures.find(
      (fixture) => fixture.name === "workspace source change"
    )!.approval as Extract<PendingApproval, { kind: "capability" }>;
    const severePanelStructural = {
      ...(fixtures.find((fixture) => fixture.name === "panel structural")!.approval as Extract<
        PendingApproval,
        { kind: "capability" }
      >),
      severity: "severe" as const,
    };

    expect(
      getStandardActionCopy(oauth as Extract<PendingApproval, { kind: "credential" }>).once.label
    ).toBe("Connect once");
    expect(
      getStandardActionCopy(gitWrite as Extract<PendingApproval, { kind: "credential" }>).once.label
    ).toBe("Push once");
    const repoBinding = fixtures.find((fixture) => fixture.name === "credential repo binding")!
      .approval as Extract<PendingApproval, { kind: "credential" }>;
    expect(getStandardActionCopy(repoBinding).repo.description).toContain(
      "GitHub repositories at github.com/acme/project"
    );
    expect(
      getStandardActionCopy(capability as Extract<PendingApproval, { kind: "capability" }>).once
        .label
    ).toBe("Open once");
    expect(getStandardActionCopy(workspaceSourceChange).once.label).toBe("Commit once");
    expect(getStandardActionCopy(workspaceSourceChange).session.description).toContain(
      "panels/spectrolite"
    );
    expect(getStandardActionCopy(severePanelAutomation).once.label).toBe("Drive once");
    expect(getStandardActionCopy(severePanelAutomation).version.label).toBe("Trust and drive");
    expect(getStandardActionCopy(severePanelStructural).once.label).toBe("Change once");
    expect(getStandardActionCopy(severePanelStructural).version.label).toBe("Trust and change");
  });

  it("formats unit-batch action labels for mixed scheduled jobs and apps", () => {
    const approval: Extract<PendingApproval, { kind: "unit-batch" }> = {
      ...base,
      kind: "unit-batch",
      trigger: "meta-change",
      title: "Workspace units changed",
      description: "Adds scheduled jobs and apps.",
      units: [
        {
          unitKind: "scheduled-job",
          unitName: "news-briefing",
          displayName: "news-briefing (every 1d at 08:00)",
          source: { kind: "workspace-repo", repo: "meta", ref: "state:next" },
          capabilities: ["invokes workers/news-agent:NewsAgentWorker/news.runScheduledJob"],
        },
        {
          unitKind: "app",
          unitName: "@workspace-apps/news",
          displayName: "News",
          source: { kind: "workspace-repo", repo: "apps/news", ref: "main" },
          capabilities: ["panel-hosting"],
        },
      ],
    };

    expect(getUnitBatchActionCopy(approval)).toMatchObject({
      once: {
        label: "Approve all",
        description: "Approve 2 workspace units (workspace apps, scheduled jobs).",
      },
      session: {
        label: "Dev session",
        description: "Allow workspace-config changes without asking again for the next 4 hours.",
      },
      deny: {
        label: "Deny all",
        description: "Do not approve these workspace units.",
      },
    });
  });

  it("formats low-level detail helpers", () => {
    const credential = fixtures.find((fixture) => fixture.name === "credential OAuth")!
      .approval as Extract<PendingApproval, { kind: "credential" }>;
    const credentialInput = fixtures.find((fixture) => fixture.name === "credential-input")!
      .approval as Extract<PendingApproval, { kind: "credential-input" }>;

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
