---
name: onboarding
description: New user onboarding — what NatStack is, first-time setup, workspace configuration, browser data import, and pointers to other skills.
---

# Onboarding Skill

Guide new users through understanding NatStack and getting their workspace set up.

## Files

| Document | Content |
|----------|---------|
| [OVERVIEW.md](OVERVIEW.md) | What NatStack is, key concepts, architecture at a glance |
| [WORKSPACE_STRUCTURE.md](WORKSPACE_STRUCTURE.md) | Workspace directory layout, meta/, context folders, template vs live |
| [GETTING_STARTED.md](GETTING_STARTED.md) | First-time setup: workspace, browser import, first panel |
| [REMOTE_SERVER.md](REMOTE_SERVER.md) | Running the state server on a different machine (home server, VPS) and connecting desktop/mobile clients to it |

## Related Skills

| Skill | When to use |
|-------|-------------|
| `browser-import` | Importing cookies, passwords, bookmarks, history from existing browsers |
| `api-integrations` | Connecting third-party APIs (Gmail, GitHub, Slack, etc.) via OAuth |
| `sandbox` | Learning the eval tool, inline UI, runtime APIs |
| `paneldev` | Building and launching panels, workers, full development workflow |

## First: Detect User Experience Level

Before starting the walkthrough, check whether the user is new or returning:

```
eval({ code: `
  import { workspace } from "@workspace/runtime";
  const workspaces = await workspace.list();
  const active = await workspace.getActive();
  return { count: workspaces.length, names: workspaces.map(w => w.name), active };
` })
```

- **New user** (`count <= 1`, or `count === 0` with an active workspace) — give the full walkthrough with explanations of key concepts. These users need context on what NatStack is and what it can do. Note: in some runtime modes `workspace.list()` may return an empty array even when an active workspace exists — treat this as a new user.
- **Returning user** (`count > 1`) — skip the overview, be succinct, and ask what they need help with. They already know the basics.

## Typical Onboarding Flow

### New Users

1. **Explain** — Read [OVERVIEW.md](OVERVIEW.md), introduce key concepts based on what the user already knows
2. **Set up workspace** — Walk through [GETTING_STARTED.md](GETTING_STARTED.md) to configure their environment
3. **Import browser data** — Use the `browser-import` skill to bring in cookies, bookmarks, passwords
4. **API integrations** — Offer to set up OAuth for Gmail, GitHub, Slack, etc. (optional, uses inline UI)
5. **First project** — Use the `paneldev` skill to scaffold and launch a panel
6. **Explore** — Point to the `sandbox` skill for runtime API exploration

### Returning Users

1. **Welcome back** — Mention their active workspace and how many workspaces they have
2. **Ask what they need** — Don't re-explain concepts. Jump straight to their goal
3. **Point to relevant skills** — Direct them to the right skill doc for what they want to do

## Interaction Patterns

See the sandbox skill's [INTERACTION_PATTERNS.md](../sandbox/INTERACTION_PATTERNS.md) for when to use inline UI vs eval for side-effect actions. During onboarding, actions like choosing a setup step, switching workspaces, or importing browser data should be inline UIs — not blind eval calls.

## Guiding Principles

- **Adapt to experience** — check workspace count first, then tailor depth accordingly.
- **Ask what they want to do** — don't dump everything at once. Tailor the walkthrough to their goals.
- **Show, don't tell** — use `eval` and `inline_ui` to demonstrate concepts live rather than just describing them.
- **Reference, don't repeat** — point to existing skill docs for deep dives rather than duplicating content.
- **Go step by step** — confirm each step works before moving to the next.

## Environment Compatibility

- Best experience is **panel-only** — `inline_ui`, interactive workflows, and browser import features require a panel rendering context. However, basic onboarding (workspace exploration, config, creating a first project) can still proceed via `eval` and plain text replies in non-panel environments.
