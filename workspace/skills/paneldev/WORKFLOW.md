# Agent Development Workflow

## Overview

Your environment is an isolated OPFS filesystem under `/workspace/`. Workflow:

1. **Discover** repos: `WorkspaceList({ category: "..." })`
2. **Clone** needed repos: `WorkspaceClone({ repo_spec: "..." })`
3. **Edit** code: `Read`, `Edit`, `Write`
4. **Commit**: `GitAdd`, `GitCommit`

---

## Step-by-Step

### 1. Discover

```
WorkspaceList({ category: "all" })
```

Filter options: `skills`, `panels`, `workers`, `contexts`, `packages`, `all`

### 2. Check Context

```
ContextInfo()
```

See what's already mounted.

### 3. Clone

```
WorkspaceClone({ repo_spec: "panels/code-editor" })
```

Options: `repo#branch`, `repo@tag`, custom mount_path.

### 4. Explore

```
Tree({ path: "/workspace/panels/code-editor" })
Read({ file_path: "/workspace/panels/code-editor/index.tsx" })
Grep({ pattern: "useState", path: "/workspace/panels/code-editor" })
```

### 5. Edit

```
Edit({
  file_path: "/workspace/panels/code-editor/index.tsx",
  old_string: "const [value, setValue] = useState('')",
  new_string: "const [value, setValue] = useState('initial')"
})
```

### 6. Commit

```
GitStatus({ path: "/workspace/panels/code-editor" })
GitDiff({ path: "/workspace/panels/code-editor" })
GitAdd({ path: "/workspace/panels/code-editor", files: ["index.tsx"] })
GitCommit({ message: "Update initial value", path: "/workspace/panels/code-editor" })
```

---

## Common Patterns

### New Panel

1. Clone existing panel as template
2. Update package.json name
3. Modify code
4. Commit

### Bug Fix

1. Clone affected panel
2. Search for issue: `Grep({ pattern: "error", path: "..." })`
3. Fix with `Edit`
4. Commit: "Fix: description"

### Check Types

```
CheckTypes({ panel_path: "/workspace/panels/code-editor" })
```

---

## Tips

1. **Read before editing** - Understand the code
2. **Small commits** - Focused changes
3. **Check types** - Catch errors early
4. **Use contracts** - Type-safe RPC (see RPC.md)
