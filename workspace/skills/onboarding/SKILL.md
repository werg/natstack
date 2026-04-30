---
name: onboarding
description: New user onboarding — what NatStack is, first-time setup, API provider integrations, browser data import, workspace configuration, and pointers to other skills.
---

# Onboarding Skill

Guide new users through understanding NatStack and getting their workspace set up.

## Files

| Document | Content |
|----------|---------|
| [OVERVIEW.md](OVERVIEW.md) | What NatStack is, key concepts, architecture at a glance |
| [WORKSPACE_STRUCTURE.md](WORKSPACE_STRUCTURE.md) | Workspace directory layout, meta/, context folders, template vs live |
| [GETTING_STARTED.md](GETTING_STARTED.md) | First-time setup: API provider integrations, browser import, workspace setup, first panel |
| [REMOTE_SERVER.md](REMOTE_SERVER.md) | Running the state server on a different machine (home server, VPS) and connecting desktop/mobile clients to it |

## Related Skills

| Skill | When to use |
|-------|-------------|
| `browser-import` | Importing cookies, passwords, bookmarks, history from existing browsers |
| `api-integrations` | Connecting third-party APIs (Gmail, GitHub, Slack, etc.) via OAuth |
| `sandbox` | Learning the eval tool, inline UI, runtime APIs |
| `paneldev` | Building and launching panels, workers, full development workflow |

## First: Detect User Experience Level

Before starting the walkthrough, check whether the user is new or returning and
collect a lightweight setup snapshot:

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

- **New user** (`workspaceCount <= 1`, or `workspaceCount === 0` with an active workspace) — give the full walkthrough with explanations of key concepts. These users need context on what NatStack is and what it can do. Note: in some runtime modes `workspace.list()` may return an empty array even when an active workspace exists — treat this as a new user.
- **Returning user** (`workspaceCount > 1`) — skip the overview, be succinct, and ask what they need help with. They already know the basics.

## Typical Onboarding Flow

### New Users

1. **Explain** — Read [OVERVIEW.md](OVERVIEW.md), introduce key concepts based on what the user already knows
2. **Recommend first actions** — Offer state-aware choices with MDX `ActionButton`s when available
3. **API integrations** — Highlight concrete provider choices: Google Workspace, GitHub, Slack, model/API keys, or custom OAuth/API provider. Do not gate this on browser data import.
4. **Import browser data** — Use the `browser-import` skill only when the user wants cookies, bookmarks, passwords, or local browser state
5. **First project** — Use the `paneldev` skill to scaffold and launch a panel
6. **Explore** — Point to the `sandbox` skill for runtime API exploration

### Returning Users

1. **Welcome back** — Mention their active workspace and how many workspaces they have
2. **Ask what they need** — Don't re-explain concepts. Jump straight to their goal
3. **Point to relevant skills** — Direct them to the right skill doc for what they want to do

## Interaction Patterns

See the sandbox skill's [MDX.md](../sandbox/MDX.md) and [INTERACTION_PATTERNS.md](../sandbox/INTERACTION_PATTERNS.md) for when to use MDX, inline UI, feedback UI, or eval. During onboarding:

- Use MDX `ActionButton`s for the initial choice list and other simple follow-up prompts.
- Use `feedback_custom` or `inline_ui` after the user chooses a setup path that needs OAuth, provider console links, browser opens, persistence, or error handling.
- Actions like switching workspaces or importing browser data should be workflow UIs, not blind eval calls.

## Guiding Principles

- **Adapt to experience** — check workspace count first, then tailor depth accordingly.
- **Ask what they want to do** — don't dump everything at once. Tailor the walkthrough to their goals.
- **Recommend from state** — mention already configured providers, imported browser data, and existing panels before suggesting next steps.
- **Keep provider setup first-class** — API provider integrations are an initial onboarding option, independent of browser data import.
- **Show, don't tell** — use `eval`, MDX, `feedback_custom`, and `inline_ui` to demonstrate concepts live rather than just describing them.
- **Reference, don't repeat** — point to existing skill docs for deep dives rather than duplicating content.
- **Go step by step** — confirm each step works before moving to the next.

## Environment Compatibility

- Best experience is **panel-only** — `inline_ui`, interactive workflows, and browser import features require a panel rendering context. However, basic onboarding (workspace exploration, config, creating a first project) can still proceed via `eval` and plain text replies in non-panel environments.
