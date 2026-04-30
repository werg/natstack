# Getting Started

A step-by-step guide for onboarding. The agent should first detect the user's experience level, then walk through the relevant steps interactively.

## Step 0: Detect Experience Level And Setup State

Before anything else, check how many workspaces exist and what is already set
up. Keep this lightweight and tolerate failures because some APIs are
panel-only or depend on optional skills.

```
eval({ code: `
  import { credentials, fs, workspace } from "@workspace/runtime";

  const workspaces = await workspace.list();
  const active = await workspace.getActive();
  const storedCredentials = await credentials.listStoredCredentials().catch(() => []);
  let google = null;
  try {
    const googleSkill = await import("@workspace-skills/google-workspace");
    google = await googleSkill.getGoogleOnboardingStatus();
  } catch (error) {
    google = { error: error instanceof Error ? error.message : String(error) };
  }
  let importHistory = [];
  try {
    const { browserData } = await import("@workspace/panel-browser");
    importHistory = await browserData.getImportHistory();
  } catch {
    importHistory = [];
  }
  const panels = await fs.readdir("/panels").catch(() => []);
  const providerIds = [...new Set(storedCredentials.map(c =>
    String(c.metadata?.providerId ?? c.providerId ?? "unknown")
  ))];

  return {
    workspaceCount: workspaces.length,
    workspaceNames: workspaces.map(w => w.name),
    active,
    providerIds,
    storedCredentialCount: storedCredentials.length,
    google,
    browserImportCount: importHistory.length,
    panelCount: panels.length,
  };
`, timeout: 10000 })
```

- **`workspaceCount <= 1`** → new user. Start from Step 1, explain concepts thoroughly. Note: in IPC/remote mode `workspace.list()` may return `[]` even when an active workspace exists — treat `workspaceCount === 0` with a valid `active` as a new user too.
- **`workspaceCount > 1`** → returning user. Greet them briefly, mention their active workspace, and ask what they need. Skip to whichever step is relevant, or point them to the right skill directly.
- Use `providerIds`, Google status, `browserImportCount`, and `panelCount` to make the first recommendations specific.

## Step 1: Explore Your Workspace

Start by showing the user what's in their workspace:

```
eval({ code: `
  import { workspace, fs } from "@workspace/runtime";
  const config = await workspace.getConfig();
  console.log("Workspace:", config.id);
  console.log("Init panels:", config.initPanels);

  const entries = await fs.readdir("/", { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  console.log("Top-level directories:", dirs.join(", "));
  return { config, dirs };
` })
```

Key directories:
- `panels/` — panel apps (UI)
- `packages/` — shared workspace packages
- `workers/` — workerd workers and Durable Objects
- `agents/` — agent definitions
- `skills/` — skill documentation (like this one)

## Step 2: Recommend a First Setup Path

After the workspace overview, ask what the user wants to do first. Present these
as peer options. Prefer an MDX message with `ActionButton`s:

```mdx
I checked the workspace. Here are good next steps:

<Flex gap="2" wrap="wrap">
  <ActionButton message="Set up Google Workspace provider integration">
    Google Workspace
  </ActionButton>
  <ActionButton message="Set up GitHub provider integration">
    GitHub
  </ActionButton>
  <ActionButton message="Set up Slack provider integration">
    Slack
  </ActionButton>
  <ActionButton message="Set up a model or API key provider">
    Model/API key
  </ActionButton>
  <ActionButton message="Set up a custom OAuth or API provider">
    Custom provider
  </ActionButton>
  <ActionButton message="Import browser data">
    Browser import
  </ActionButton>
  <ActionButton message="Help me build a panel">
    Build a panel
  </ActionButton>
</Flex>
```

If MDX is not available, use the same choices in a concise plain-text list:

1. **Connect API providers** — set up Gmail, GitHub, Slack, or other provider
   integrations through OAuth/credentials. This is available immediately and
   does not require importing browser data.
2. **Import browser data** — bring in cookies, bookmarks, passwords, or history
   from Chrome/Firefox/etc. when they want local browser state in NatStack.
3. **Build something** — scaffold and launch a panel app.
4. **Organize workspaces** — create, fork, or switch workspaces.
5. **Explore capabilities** — inspect runtime APIs and live examples.

Only run browser import when the user chooses browser data or specifically needs
local browser state. OAuth/API provider setup should go straight to the relevant
provider setup flow.

## Step 3: Set Up API Integrations (Credentials)

API integrations use the credential system. See `docs/credential-system.md` for the current architecture and provider setup details.

For Google Workspace, load the dedicated setup skill:

```
read("skills/google-workspace/SKILL.md")
```

Then use `getGoogleOnboardingStatus()` from
`@workspace-skills/google-workspace` to detect state and guide the user through
`skills/google-workspace/ONBOARDING.md` and the workflow UI in
`skills/google-workspace/SETUP.md` when configuration is missing. Do not paste
the Google Cloud setup checklist into chat as plain text; show the workflow UI
with internal/external deep links.

**Check if already configured:**

```
eval({ code: `
  import { credentials } from "@workspace/runtime";
  import {
    formatGoogleOnboardingStatus,
    getGoogleOnboardingStatus,
  } from "@workspace-skills/google-workspace";
  const storedCredentials = await credentials.listStoredCredentials();
  const googleStatus = await getGoogleOnboardingStatus();
  console.log(formatGoogleOnboardingStatus(googleStatus));
  const providerIds = [...new Set(storedCredentials.map(c =>
    String(c.metadata?.providerId ?? c.providerId ?? "unknown")
  ))];
  if (providerIds.length > 0 || googleStatus.connected) {
    console.log("Configured providers:", [...new Set([
      ...providerIds,
      ...(googleStatus.connected ? ["google-workspace"] : []),
    ])].join(", "));
  } else {
    console.log("No stored provider credentials are configured yet.");
  }
  return { configured: providerIds.length > 0 || googleStatus.connected, providerIds, googleStatus };
`, timeout: 10000 })
```

## Step 4: Import Browser Data

If the user wants to bring in their existing browser data (cookies for authentication, bookmarks, passwords), use the **browser-import** skill.

Quick start — detect what browsers are available:

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  const browsers = await browserData.detectBrowsers();
  for (const b of browsers) {
    const status = b.tccBlocked ? " (blocked — needs permission)" : "";
    console.log(b.displayName + status + " — " + b.profiles.length + " profile(s)");
    for (const p of b.profiles) {
      console.log("  " + p.displayName + (p.isDefault ? " (default)" : ""));
    }
  }
  return browsers;
`, timeout: 30000 })
```

Then ask the user which browser/profile to import from and which data types they want. See the `browser-import` skill docs for:
- [DISCOVERY.md](../browser-import/DISCOVERY.md) — browser detection and profile enumeration
- [IMPORT.md](../browser-import/IMPORT.md) — running imports
- [COOKIES.md](../browser-import/COOKIES.md) — cookie management and session sync
- [PASSWORDS.md](../browser-import/PASSWORDS.md) — password vault
- [BOOKMARKS.md](../browser-import/BOOKMARKS.md) — bookmark browsing
- [WORKFLOWS.md](../browser-import/WORKFLOWS.md) — end-to-end recipes

## Step 5: Set Up a Workspace

If the user wants to organize their work into separate workspaces:

```
eval({ code: `
  import { workspace } from "@workspace/runtime";

  // List existing workspaces
  const workspaces = await workspace.list();
  console.log("Workspaces:");
  for (const ws of workspaces) {
    const active = ws.name === await workspace.getActive() ? " (active)" : "";
    console.log("  " + ws.name + active);
  }
  return workspaces;
` })
```

Create a new workspace (optionally forking from an existing one):

```
eval({ code: `
  import { workspace } from "@workspace/runtime";
  const active = await workspace.getActive();
  const entry = await workspace.create("my-workspace", { forkFrom: active });
  console.log("Created workspace:", entry.name);
` })
```

Configure which panels open on first launch:

```
eval({ code: `
  import { workspace } from "@workspace/runtime";
  await workspace.setInitPanels([{ source: "panels/chat" }]);
  console.log("Init panels set");
` })
```

Switch to a workspace (this relaunches the app):

```
eval({ code: `
  import { workspace } from "@workspace/runtime";
  await workspace.switchTo("my-workspace");
` })
```

## Step 6: Create Your First Panel

Use the **paneldev** skill to scaffold and launch a panel. See the `paneldev` skill for the full workflow:
- [WORKFLOW.md](../paneldev/WORKFLOW.md) — step-by-step development process
- [PANEL_DEVELOPMENT.md](../paneldev/PANEL_DEVELOPMENT.md) — hooks, filesystem, templates
- [PANEL_SYSTEM.md](../paneldev/PANEL_SYSTEM.md) — API reference

Quick version:

```
eval({ code: `
  import { createProject } from "@workspace-skills/paneldev";
  await createProject({ projectType: "panel", name: "hello", title: "Hello World" });
`, timeout: 30000 })
```

Then edit the generated files with Read/Edit/Write tools and launch:

```
eval({ code: `
  import { commitAndPush } from "@workspace-skills/paneldev";
  import { openPanel } from "@workspace/runtime";
  await commitAndPush("panels/hello", "Initial launch");
  await openPanel("panels/hello");
`, timeout: 30000 })
```

## Step 7: Explore the Runtime

Use the **sandbox** skill to learn what you can do from the chat panel:
- [EVAL.md](../sandbox/EVAL.md) — running code in the sandbox
- [INLINE_UI.md](../sandbox/INLINE_UI.md) — rendering interactive components in chat
- [RUNTIME_API.md](../sandbox/RUNTIME_API.md) — full API reference (fs, db, ai, workers, etc.)
- [BROWSER_AUTOMATION.md](../sandbox/BROWSER_AUTOMATION.md) — Playwright via CDP
- [PATTERNS.md](../sandbox/PATTERNS.md) — common recipes

## Adapting the Flow

Not every user needs every step. Tailor the walkthrough:

| User goal | Steps to focus on |
|-----------|-------------------|
| "I want to browse the web with my logins" | Steps 1, 2, 4 (import cookies + sync) |
| "I want to connect Gmail/Slack/GitHub" | Steps 1, 2, 3 (OAuth/API setup; no browser import required) |
| "I want to build an app" | Steps 1, 2, 6 (scaffold + launch panel) |
| "I want to organize my projects" | Steps 1, 2, 5 (workspace management) |
| "I want to see what this can do" | Steps 1, 2, 7 (explore runtime APIs) |
| "Set everything up" | All steps in order |

Ask the user what they're most interested in and skip to the relevant section.
