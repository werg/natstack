# Getting Started

A step-by-step guide for onboarding. The agent should first detect the user's experience level, then walk through the relevant steps interactively.

## Step 0: Detect Experience Level And Setup State

Before anything else, check how many workspaces exist and what is already set
up. Keep this lightweight and tolerate helper-call failures because some APIs
are panel-only or depend on optional services/runtime state.

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  import { getGoogleOnboardingStatus } from "@workspace-skills/google-workspace";
  import { getActiveSearchProvider } from "@workspace-skills/web-research";

  const workspaces = await services.workspace.list();
  const active = await services.workspace.getActive();
  const storedCredentials = await services.credentials.listStoredCredentials().catch(() => []);
  const google = await getGoogleOnboardingStatus()
    .catch(error => ({ error: error instanceof Error ? error.message : String(error) }));
  const importHistory = await browserData.getImportHistory().catch(() => []);
  const searchProvider = await getActiveSearchProvider().catch(() => "duckduckgo");
  const panels = await fs.readdir("panels").catch(() => []);
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
    searchProvider, // "tavily" | "brave" | "exa" | "duckduckgo"
    browserImportCount: importHistory.length,
    panelCount: panels.length,
  };
`
})
```

- Use static imports for runtime APIs, workspace packages, and workspace skills.
  `await import(...)` bypasses the eval loader's static dependency planning and
  is not the supported way to load `@workspace/*`, `@workspace-skills/*`, or
  `@natstack/*` modules.
- `fs` paths are rooted at the current context folder. `panels` and `/panels`
  resolve to the same workspace source directory; prefer `panels` in docs and
  examples so agents do not mistake it for a host absolute path.

- **`workspaceCount <= 1`** → new user. Start from Step 1, explain concepts thoroughly. Note: in IPC/remote mode `workspace.list()` may return `[]` even when an active workspace exists — treat `workspaceCount === 0` with a valid `active` as a new user too.
- **`workspaceCount > 1`** → returning user. Greet them briefly, mention their active workspace, and ask what they need. Skip to whichever step is relevant, or point them to the right skill directly.
- Use `providerIds`, Google status, `searchProvider`, `browserImportCount`, and `panelCount` to make the first recommendations specific. A `searchProvider === "duckduckgo"` value is fine for most users; only suggest upgrading if they bring up research, hit rate limits, or ask about search quality.

## Step 1: Explore Your Workspace

Start by showing the user what's in their workspace:

```
eval({ code: `
  const config = await services.workspace.getConfig();
  console.log("Workspace:", config.id);
  console.log("Init panels:", config.initPanels);

  const entries = await fs.readdir(".", { withFileTypes: true });
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  console.log("Top-level directories:", dirs.join(", "));
  return { config, dirs };
` })
```

Key directories:

- `panels/` — panel apps (UI)
- `packages/` — shared workspace packages
- `workers/` — workerd workers and Durable Objects
- `skills/` — skill documentation (like this one)
- `projects/` — plain editable repos

## Step 2: Recommend a First Setup Path

After the workspace overview, ask what the user wants to do first. In the
template workspace, the chat panel loads [ActionBar.tsx](ActionBar.tsx) through
`actionBarFile` in `meta/natstack.yml`, so these choices are already pinned
above the chat history before the first agent reply:

- **Google Workspace** — set up Google provider integration
- **GitHub** — set up GitHub provider integration
- **Slack** — set up Slack provider integration
- **Model key** — set up a model or API key provider credential
- **Agent defaults** — change the default model, swap providers, or tune effort/approval/chattiness; load the `agent-tuning` skill
- **Web search upgrade** — register a Tavily / Brave / Exa key so `web_search` graduates from DuckDuckGo (optional; see `web-research` skill)
- **Custom API** — set up a custom OAuth or API provider
- **Browser import** — import cookies, bookmarks, passwords, or local browser state
- **Build panel** — scaffold and launch a panel app
- **Explore runtime** — inspect runtime APIs and live examples
- **Workspaces** — create, fork, or switch workspaces

Do not duplicate that full list in the first message. Mention the most relevant
state-aware next steps and tell the user they can use the pinned actions or ask
for something specific.

Use MDX `ActionButton`s only as a fallback when the action bar is unavailable,
or later in the transcript for contextual choices that are not already pinned.

If neither the action bar nor MDX is available, use the same choices in a
concise plain-text list:

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
  import {
    formatGoogleOnboardingStatus,
    getGoogleOnboardingStatus,
  } from "@workspace-skills/google-workspace";
  import { getActiveSearchProvider } from "@workspace-skills/web-research";
  const storedCredentials = await services.credentials.listStoredCredentials();
  const googleStatus = await getGoogleOnboardingStatus();
  const searchProvider = await getActiveSearchProvider();
  console.log(formatGoogleOnboardingStatus(googleStatus));
  console.log("Active web_search provider:", searchProvider);
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
  return {
    configured: providerIds.length > 0 || googleStatus.connected,
    providerIds,
    googleStatus,
    searchProvider,
  };
`
})
```

### Optional: Upgrade web search

`web_search` works zero-config via DuckDuckGo, but DDG rate-limits and ships
short snippets. If the user is doing real research or hits a
`DuckDuckGoBlockedError`, offer to register a Tavily / Brave / Exa key. Use
the **web-research** skill's helpers — each pops the trusted credential-input
UI and stores the key encrypted, bound to the provider's API origin:

```
eval({ code: `
  import { requestTavilyApiKey } from "@workspace-skills/web-research";
  await requestTavilyApiKey(); // user pastes the key into the trusted prompt
` })
```

Same shape for `requestBraveApiKey()` and `requestExaApiKey()`. Provider
preference is fixed: **Tavily > Brave > Exa > DuckDuckGo**; the first one
with a stored credential wins.

## Step 3.5: Tune The Agent

Cold-start choices live in `packages/agentic-do/src/agent-config.ts`; provider
credential presets are derived from `@workspace/model-catalog/providerConnect`.
Edit and reload or resubscribe to change the default model/provider. Session
knobs (effort, approval, chattiness) are agent method calls that can change
during a conversation. Use the `agent-tuning` skill for either path.

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
`
})
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
  // List existing workspaces
  const workspaces = await services.workspace.list();
  console.log("Workspaces:");
  for (const ws of workspaces) {
    const active = ws.name === await services.workspace.getActive() ? " (active)" : "";
    console.log("  " + ws.name + active);
  }
  return workspaces;
` })
```

Create a new workspace (optionally forking from an existing one):

```
eval({ code: `
  const active = await services.workspace.getActive();
  const entry = await services.workspace.create("my-workspace", { forkFrom: active });
  console.log("Created workspace:", entry.name);
` })
```

Configure which panels open on first launch:

```
eval({ code: `
  await services.workspace.setInitPanels([{ source: "panels/chat" }]);
  console.log("Init panels set");
` })
```

Switch to a workspace (this relaunches the app):

```
eval({ code: `
  await services.workspace.switchTo("my-workspace");
` })
```

## Step 6: Create Your First Panel

Use the **workspace-dev** skill to scaffold and launch a panel. See the `workspace-dev` skill for the full workflow:

- [WORKFLOW.md](../workspace-dev/WORKFLOW.md) — step-by-step development process
- [WORKFLOW.md](../workspace-dev/WORKFLOW.md) — agent panel workflow
- [PANEL_API.md](../workspace-dev/PANEL_API.md) — runtime panel API reference

Quick version:

```
eval({ code: `
  import { createProject } from "@workspace-skills/workspace-dev";
  await createProject({ projectType: "panel", name: "hello", title: "Hello World" });
`
})
```

Then edit the generated files with Read/Edit/Write tools — each edit is recorded
as a tracked WORKING change on your context head and projected to disk (no commit
or build yet). Seal milestones with `vcs.commit({ message })`, preview a build on
demand with `vcs.previewBuild`, and `vcs.push` to build-gate it into `main` — and
launch.

`openPanel` is part of the portable runtime surface from `@workspace/runtime`;
it works from server-side eval, panels, workers, and DOs:

```tsx
import { openPanel } from "@workspace/runtime";
await openPanel("panels/hello");
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

| User goal                                 | Steps to focus on                                           |
| ----------------------------------------- | ----------------------------------------------------------- |
| "I want to browse the web with my logins" | Steps 1, 2, 4 (import cookies + sync)                       |
| "I want to connect Gmail/Slack/GitHub"    | Steps 1, 2, 3 (OAuth/API setup; no browser import required) |
| "I want to build an app"                  | Steps 1, 2, 6 (scaffold + launch panel)                     |
| "I want to organize my projects"          | Steps 1, 2, 5 (workspace management)                        |
| "I want to see what this can do"          | Steps 1, 2, 7 (explore runtime APIs)                        |
| "Set everything up"                       | All steps in order                                          |

Ask the user what they're most interested in and skip to the relevant section.
