# Agent Development Workflow

## Overview

Your working directory is the context folder. Use native SDK tools (Bash, Read, Write, Edit, Glob, Grep) to develop panels. Workflow:

1. **Explore** the workspace: `Bash`, `Glob`, `Read`
2. **Edit** code: `Read`, `Edit`, `Write`
3. **Commit**: `Bash` with git commands

---

## Step-by-Step

### 1. Explore

```
Bash({ command: "ls panels/" })
Glob({ pattern: "panels/*/package.json" })
```

### 2. Read Code

```
Read({ file_path: "panels/code-editor/index.tsx" })
Grep({ pattern: "useState", path: "panels/code-editor" })
```

### 3. Edit

```
Edit({
  file_path: "panels/code-editor/index.tsx",
  old_string: "const [value, setValue] = useState('')",
  new_string: "const [value, setValue] = useState('initial')"
})
```

### 4. Commit

```
Bash({ command: "git status" })
Bash({ command: "git diff" })
Bash({ command: "git add panels/code-editor/index.tsx && git commit -m 'Update initial value'" })
```

---

## Common Patterns

### New Panel

1. Read an existing panel as reference
2. Write new panel files (package.json, index.tsx)
3. Commit

### Bug Fix

1. Search for issue: `Grep({ pattern: "error", path: "panels/..." })`
2. Fix with `Edit`
3. Commit: "Fix: description"

### Check Types

```
CheckTypes({ panel_path: "panels/code-editor" })
```

---

## Tips

1. **Read before editing** - Understand the code
2. **Small commits** - Focused changes
3. **Check types** - Catch errors early
4. **Use contracts** - Type-safe RPC (see RPC.md)
