# Agent Development Workflow

## Overview

Your working directory is the **context folder** — an isolated copy of the workspace. All paths are relative to this root. **Never use absolute paths or Bash for file/git operations.**

All runtime operations (project creation, git, typecheck, tests, launching) are done via **eval** with `@workspace/runtime`. Use **static imports** and note that `contextId` is **pre-injected** (do NOT import it).

---

## Step-by-Step

### 1. Create

Scaffold a new project via eval:

```
eval({ code: `
  import { rpc } from "@workspace/runtime";
  await rpc.call("main", "project.create", contextId, "panel", "my-app", "My App");
`, timeout: 30000 })
```

This creates the project directory with `package.json` (including dependencies), `index.tsx`, initializes git, commits, and pushes. **Do not create project files manually.**

After creation, the files are immediately available in your working directory at `panels/my-app/`.

### 2. Develop

Read existing code, then edit or write changes:

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
  import { rpc, buildPanelLink } from "@workspace/runtime";
  await rpc.call("main", "git.contextOp", contextId, "commit_and_push", "panels/my-app", "Initial launch");
  window.open(buildPanelLink("panels/my-app", { contextId }));
`, timeout: 30000 })
```

`window.open` creates a child panel view. The host intercepts the open and creates a proper panel.

### 5. Iterate

Edit files, then commit+push and re-open (rebuild happens on-demand):

```
eval({ code: `
  import { rpc, buildPanelLink } from "@workspace/runtime";
  await rpc.call("main", "git.contextOp", contextId, "commit_and_push", "panels/my-app", "Update");
  window.open(buildPanelLink("panels/my-app", { contextId }));
`, timeout: 30000 })
```

---

## Common Patterns

### New Panel

1. Create via eval (`project.create`)
2. Edit the generated `index.tsx`
3. Launch via eval (`commit_and_push` + `window.open(buildPanelLink(...))`)

### Iterating on Code

1. Edit files with `Edit`
2. Rebuild via eval (`commit_and_push` + `window.open(buildPanelLink(...))`)

3. Read the error or inspect the panel
4. Edit again, rebuild again

### Bug Fix

1. Search for the issue: `Grep({ pattern: "error", path: "panels/..." })`
2. Fix with `Edit`
3. Rebuild via eval

---

## Tips

1. **Read before editing** — Understand the code
2. **Use static imports in eval** — `import { rpc } from "@workspace/runtime"`, NOT `await import(...)`
3. **contextId is pre-injected** — Use it directly, do NOT import it from the runtime
4. **Relative paths only** — All paths are relative to your working directory
5. **Check types early** — Catch errors before launching
6. **Read build errors** — If launch fails, the error tells you what to fix
7. **Use buildPanelLink for navigation** — `buildPanelLink(source, { contextId })` builds the correct URL
