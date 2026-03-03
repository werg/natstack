# Agent Development Workflow

## Overview

Your working directory is the context folder. Use structured tools to develop panels, packages, skills, and agents.

---

## Step-by-Step

### 1. Create

Scaffold a new project with boilerplate:

```
create_project({ type: "panel", name: "my-app", title: "My App" })
```

This creates the project directory, initializes git, and pushes to trigger auto-build.

### 2. Develop

Read existing code, then edit or write changes:

```
Read({ file_path: "panels/my-app/index.tsx" })
Grep({ pattern: "useState", path: "panels/my-app" })

Edit({
  file_path: "panels/my-app/index.tsx",
  old_string: "const [value, setValue] = useState('')",
  new_string: "const [value, setValue] = useState('initial')"
})
```

### 3. Verify

Type-check and run tests:

```
check_types({ panel_path: "panels/my-app" })
run_tests({ target: "panels/my-app" })
```

### 4. Commit

Review changes and commit:

```
git({ operation: "status" })
git({ operation: "diff" })
git({ operation: "commit", message: "Add counter component" })
```

### 5. Ship

Push to trigger auto-build:

```
git({ operation: "push" })
```

### 6. Preview

Launch the panel and interact with it:

```
launch_panel({ source: "panels/my-app" })
```

For automated testing, use eval with the returned panel ID to drive Playwright.

---

## Common Patterns

### New Panel

1. `create_project({ type: "panel", name: "my-app" })`
2. Edit the generated `index.tsx`
3. `check_types({ panel_path: "panels/my-app" })`
4. `git({ operation: "commit", message: "Initial panel" })`
5. `git({ operation: "push" })`

### Bug Fix

1. Search for the issue: `Grep({ pattern: "error", path: "panels/..." })`
2. Fix with `Edit`
3. `check_types({ panel_path: "panels/..." })`
4. `git({ operation: "commit", message: "Fix: description" })`
5. `git({ operation: "push" })`

---

## Tips

1. **Read before editing** — Understand the code
2. **Small commits** — Focused changes
3. **Check types** — Catch errors early
4. **Run tests** — Verify behavior
5. **Use contracts** — Type-safe RPC (see RPC.md)
