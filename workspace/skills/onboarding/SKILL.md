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
| [GETTING_STARTED.md](GETTING_STARTED.md) | First-time setup: workspace, browser import, first panel |

## Related Skills

| Skill | When to use |
|-------|-------------|
| `browser-import` | Importing cookies, passwords, bookmarks, history from existing browsers |
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

- **New user** (1 workspace, the default) — give the full walkthrough with explanations of key concepts. These users need context on what NatStack is and what it can do.
- **Returning user** (multiple workspaces) — skip the overview, be succinct, and ask what they need help with. They already know the basics.

## Typical Onboarding Flow

### New Users

1. **Explain** — Read [OVERVIEW.md](OVERVIEW.md), introduce key concepts based on what the user already knows
2. **Set up workspace** — Walk through [GETTING_STARTED.md](GETTING_STARTED.md) to configure their environment
3. **Import browser data** — Use the `browser-import` skill to bring in cookies, bookmarks, passwords
4. **First project** — Use the `paneldev` skill to scaffold and launch a panel
5. **Explore** — Point to the `sandbox` skill for runtime API exploration

### Returning Users

1. **Welcome back** — Mention their active workspace and how many workspaces they have
2. **Ask what they need** — Don't re-explain concepts. Jump straight to their goal
3. **Point to relevant skills** — Direct them to the right skill doc for what they want to do

## Guiding Principles

- **Adapt to experience** — check workspace count first, then tailor depth accordingly.
- **Ask what they want to do** — don't dump everything at once. Tailor the walkthrough to their goals.
- **Show, don't tell** — use `eval` and `inline_ui` to demonstrate concepts live rather than just describing them.
- **Reference, don't repeat** — point to existing skill docs for deep dives rather than duplicating content.
- **Go step by step** — confirm each step works before moving to the next.
