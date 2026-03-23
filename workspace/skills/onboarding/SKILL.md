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

## Typical Onboarding Flow

1. **Explain** — Read [OVERVIEW.md](OVERVIEW.md), introduce key concepts based on what the user already knows
2. **Set up workspace** — Walk through [GETTING_STARTED.md](GETTING_STARTED.md) to configure their environment
3. **Import browser data** — Use the `browser-import` skill to bring in cookies, bookmarks, passwords
4. **First project** — Use the `paneldev` skill to scaffold and launch a panel
5. **Explore** — Point to the `sandbox` skill for runtime API exploration

## Guiding Principles

- **Ask what they want to do** — don't dump everything at once. Tailor the walkthrough to their goals.
- **Show, don't tell** — use `eval` and `inline_ui` to demonstrate concepts live rather than just describing them.
- **Reference, don't repeat** — point to existing skill docs for deep dives rather than duplicating content.
- **Go step by step** — confirm each step works before moving to the next.
