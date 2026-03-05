# Agent Tools Reference

Your working directory is the **context folder** — an isolated copy of the workspace.

**CRITICAL RULES:**
- All file paths are **relative to your working directory** (e.g., `panels/my-app/index.tsx`)
- **NEVER** use absolute paths (e.g., `/home/.../workspace/panels/...`)
- **NEVER** use `Bash` for git operations, file listing, or file creation — use the structured tools
- In eval, use **static imports** (`import { rpc } from "@workspace/runtime"`), NOT dynamic `await import(...)`
- `contextId` is **pre-injected** — use it directly, do NOT import it from `@workspace/runtime`

---

## Filesystem Tools (Native SDK)

### Read

Read file contents.

```
Read({ file_path: "panels/my-app/index.tsx" })
```

### Write

Create or overwrite a file.

```
Write({ file_path: "panels/my-app/index.tsx", content: "..." })
```

### Edit

Edit a file using string replacement.

```
Edit({
  file_path: "panels/my-app/index.tsx",
  old_string: "const [value, setValue] = useState('')",
  new_string: "const [value, setValue] = useState('initial')"
})
```

### Glob

Find files by glob pattern.

```
Glob({ pattern: "**/*.tsx" })
Glob({ pattern: "panels/*/package.json" })
```

### Grep

Search file contents with regex.

```
Grep({ pattern: "useState", path: "panels/my-app" })
Grep({ pattern: "import.*runtime", type: "ts" })
```

---

## eval

Execute TypeScript/JavaScript code in the panel runtime. Runtime APIs are available via static imports from `@workspace/runtime`.

**IMPORTANT:**
- Use static `import` syntax, NOT dynamic `await import(...)`.
- `contextId` is **pre-injected** — use it directly, do NOT import it from the runtime.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `code` | string | Yes | Code to execute |
| `syntax` | `"typescript"` \| `"tsx"` \| `"jsx"` | No | Syntax mode (default: `"tsx"`) |
| `timeout` | number | No | Max async wait in ms (default: 10000, max: 90000) |

### Runtime APIs

Available via `import { ... } from "@workspace/runtime"`:

| API | Description |
|-----|-------------|
| `rpc` | RPC bridge for calling main-process services via `rpc.call(target, method, ...args)` |
| `createChild(source, opts)` | Create a child panel |
| `createBrowserChild(url)` | Create a browser child |
| `focusPanel(panelId)` | Focus an existing panel by ID |

**Pre-injected** (use directly, do NOT import):

| Variable | Description |
|----------|-------------|
| `contextId` | Current agent context ID for scoped operations |

### RPC Services

Called via `rpc.call("main", "service.method", ...args)`:

#### project.create

Scaffold a new workspace project (panel, package, skill, agent).

```
eval({ code: `
  import { rpc } from "@workspace/runtime";
  await rpc.call("main", "project.create", contextId, "panel", "my-app", "My App");
`, timeout: 30000 })
```

#### git.contextOp

Git operations scoped to the current context.

```
// Status
eval({ code: `
  import { rpc } from "@workspace/runtime";
  const status = await rpc.call("main", "git.contextOp", contextId, "status");
  console.log(status);
`, timeout: 30000 })

// Commit and push
eval({ code: `
  import { rpc } from "@workspace/runtime";
  await rpc.call("main", "git.contextOp", contextId, "commit_and_push", "panels/my-app", "Update");
`, timeout: 30000 })
```

Operations: `status`, `diff`, `log`, `commit`, `push`, `commit_and_push`

#### typecheck.check

Run TypeScript type checking on a panel/package.

```
eval({ code: `
  import { rpc } from "@workspace/runtime";
  const result = await rpc.call("main", "typecheck.check", "panels/my-app");
  console.log(result);
`, timeout: 30000 })
```

#### test.run

Run vitest tests on a workspace panel or package.

```
eval({ code: `
  import { rpc } from "@workspace/runtime";
  const result = await rpc.call("main", "test.run", contextId, "panels/my-app");
  console.log(result);
`, timeout: 60000 })
```

### Panel Lifecycle

#### First launch

```
eval({ code: `
  import { rpc, createChild, focusPanel } from "@workspace/runtime";
  await rpc.call("main", "git.contextOp", contextId, "commit_and_push", "panels/my-app", "Initial");
  const handle = await createChild("panels/my-app", { contextId });
  focusPanel(handle.id);
  console.log("Panel ID:", handle.id);
`, timeout: 30000 })
```

#### Rebuild after edits

```
eval({ code: `
  import { rpc, focusPanel } from "@workspace/runtime";
  await rpc.call("main", "git.contextOp", contextId, "commit_and_push", "panels/my-app", "Update");
  focusPanel("<panel-id>");
`, timeout: 30000 })
```

---

## Web Tools

### web_search

Search the web for information.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `allowed_domains` | string[] | No | Only include results from these domains |
| `blocked_domains` | string[] | No | Exclude results from these domains |

### web_fetch

Fetch and process content from a URL.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | string | Yes | URL to fetch |
| `prompt` | string | Yes | What to extract from the page |
