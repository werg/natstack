---
name: paneldev
description: NatStack panel development docs - hooks, contracts, filesystem, git, AI. Clone and read SKILL.md to start.
---

# Panel Development Skill

Documentation for developing NatStack panels.

## Files

| Document | Content |
|----------|---------|
| [PANEL_DEVELOPMENT.md](PANEL_DEVELOPMENT.md) | Hooks, fs, workers, templates |
| [PANEL_SYSTEM.md](PANEL_SYSTEM.md) | API reference |
| [RPC.md](RPC.md) | Typed parent-child contracts |
| [AI.md](AI.md) | AI and browser automation |
| [TOOLS.md](TOOLS.md) | Agent tools reference |
| [WORKFLOW.md](WORKFLOW.md) | Development workflow |

## Quick Start

1. Read: `Read({ file_path: "skills/paneldev/PANEL_DEVELOPMENT.md" })`

## Panel Template

```tsx
// panels/my-app/index.tsx
export default function MyApp() {
  return <div>Hello World!</div>;
}
```

```json
// panels/my-app/package.json
{
  "name": "@workspace-panels/my-app",
  "natstack": { "type": "app", "title": "My App" }
}
```

## Common Tasks

| Task | Command |
|------|---------|
| List files | `Bash({ command: "ls panels/" })` |
| Read a file | `Read({ file_path: "panels/my-app/index.tsx" })` |
| Edit a file | `Edit({ file_path: "panels/my-app/index.tsx", old_string: "...", new_string: "..." })` |
| Git status | `Bash({ command: "git status" })` |
| Commit | `Bash({ command: "git add -A && git commit -m '...'" })` |
