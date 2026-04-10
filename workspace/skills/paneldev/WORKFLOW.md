# Agent Development Workflow

## Overview

Your working directory is the **context folder** — an isolated copy of the workspace. All paths are relative to this root. **Never use absolute paths or Bash for file/git operations.**

Runtime operations (project creation, git, typecheck, tests, launching) are done via **eval** with `@workspace/runtime`. Use **static imports**.

---

## Step-by-Step

### 1. Create

Scaffold a new project via eval with the `imports` parameter. This writes template files, initializes git, and pushes directly to the internal git server:

```
eval({ code: `
  import { createProject } from "@workspace-skills/paneldev";
  await createProject({ projectType: "panel", name: "my-app", title: "My App" });
`, timeout: 30000 })
```

After creation, the files are available in your working directory at `panels/my-app/`.

### 2. Develop

Read existing code, then edit or write changes using the **filesystem tools** (Read, Edit, Write — NOT eval):

```
Read({ file_path: "panels/my-app/index.tsx" })

Edit({
  file_path: "panels/my-app/index.tsx",
  old_string: "const [value, setValue] = useState('')",
  new_string: "const [value, setValue] = useState('initial')"
})
```

### 3. Verify (optional)

Type-check and run tests via eval:

```
eval({ code: `
  import { rpc } from "@workspace/runtime";
  const result = await rpc.call("main", "typecheck.check", "panels/my-app");
  console.log(result);
`, timeout: 30000 })

eval({ code: `
  import { rpc } from "@workspace/runtime";
  const result = await rpc.call("main", "test.run", contextId, "panels/my-app");
  console.log(result);
`, timeout: 60000 })
```

### 4. Launch

Commit, push, and open as a child panel (build happens on-demand):

```
eval({ code: `
  import { commitAndPush } from "@workspace-skills/paneldev";
  import { openPanel } from "@workspace/runtime";
  await commitAndPush("panels/my-app", "Initial launch");
  await openPanel("panels/my-app");
`, timeout: 30000 })
```

### 5. Iterate

Edit files with Edit/Write tools, then commit+push and re-open (rebuild happens on-demand):

```
eval({ code: `
  import { commitAndPush } from "@workspace-skills/paneldev";
  import { openPanel } from "@workspace/runtime";
  await commitAndPush("panels/my-app", "Update");
  await openPanel("panels/my-app");
`, timeout: 30000 })
```

---

## Common Patterns

### New Panel

1. `eval` — `import { createProject } from "@workspace-skills/paneldev"` then call `createProject({ ... })`
   - `createProject()` accepts an optional `template` parameter (e.g., `template: "svelte"`) to scaffold with a non-default workspace template. When omitted, the default React+Radix template is used.
2. Edit the generated `index.tsx` using Edit/Write tools
3. Launch via eval (`commitAndPush(...)` + `openPanel(...)`)

### Iterating on Code

1. Edit files with `Edit` / `Write`
2. Launch via eval (`commitAndPush(...)` + `openPanel(...)`)
3. Read the error or inspect the panel
4. Edit again, rebuild again

### Bug Fix

1. Search for the issue: `Grep({ pattern: "error", path: "panels/..." })`
2. Fix with `Edit`
3. Rebuild via eval

---

## Tips

1. **Read before editing** — Understand the code
2. **Use filesystem tools for file edits** — Read, Edit, Write (not eval)
3. **Use eval only for runtime operations** — git, typecheck, tests, launching
4. **Use static imports in eval** — `import { rpc } from "@workspace/runtime"`, NOT `await import(...)`
5. **Relative paths only** — All paths are relative to your working directory
7. **Check types early** — Catch errors before launching
8. **Read build errors** — If launch fails, the error tells you what to fix
9. **Use openPanel for launching** — `openPanel(source)` handles both workspace panels and URLs
