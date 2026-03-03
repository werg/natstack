# Agent Tools Reference

Agents use native SDK tools (Read, Write, Edit, Glob, Grep) and PubSub tools for operations that require the panel runtime or main process.

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

## Project Management

### create_project

Scaffold a new workspace project with boilerplate files. Automatically initializes git and pushes to trigger auto-build.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `type` | `"panel"` \| `"package"` \| `"skill"` \| `"agent"` | Yes | Project type |
| `name` | string | Yes | Directory and package name suffix |
| `title` | string | No | Human-readable title (defaults to name) |

```
create_project({ type: "panel", name: "my-app", title: "My App" })
create_project({ type: "package", name: "utils" })
```

### git

Git operations on the workspace context folder.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `operation` | `"status"` \| `"diff"` \| `"commit"` \| `"log"` \| `"push"` | Yes | Git operation |
| `path` | string | No | Relative path within workspace (default: root) |
| `message` | string | For commit | Commit message |
| `files` | string[] | No | Files to stage (default: all changed) |

```
git({ operation: "status" })
git({ operation: "diff" })
git({ operation: "commit", message: "Add counter component" })
git({ operation: "log" })
git({ operation: "push" })
```

---

## Quality & Testing

### check_types

Run TypeScript type checking on panel/worker files. Returns diagnostics (errors, warnings) from the TypeScript compiler.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `panel_path` | string | Yes | Relative or absolute path to the panel/worker root |
| `file_path` | string | No | Specific file to check |

```
check_types({ panel_path: "panels/my-app" })
check_types({ panel_path: "panels/my-app", file_path: "index.tsx" })
```

### run_tests

Run vitest tests on a workspace panel or package.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `target` | string | Yes | Relative path to panel/package |
| `file` | string | No | Specific test file |
| `test_name` | string | No | Filter by test name pattern |

```
run_tests({ target: "panels/my-app" })
run_tests({ target: "panels/my-app", file: "counter.test.tsx" })
run_tests({ target: "packages/utils", test_name: "formatDate" })
```

**What's covered:** Pure logic tests, component tests with mocked runtime globals, package tests.

**Not covered (use `eval` or `launch_panel` + Playwright):** Tests needing live RPC/transport, integration tests against running panels.

### get_type_info

Get TypeScript type information at a specific position.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `panel_path` | string | Yes | Relative or absolute path to the panel/worker root |
| `file_path` | string | Yes | Path to the file |
| `line` | number | Yes | Line number (1-indexed) |
| `column` | number | Yes | Column number (1-indexed) |

### get_completions

Get code completions at a specific position.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `panel_path` | string | Yes | Relative or absolute path to the panel/worker root |
| `file_path` | string | Yes | Path to the file |
| `line` | number | Yes | Line number (1-indexed) |
| `column` | number | Yes | Column number (1-indexed) |

---

## Runtime Tools

### launch_panel

Launch a child panel or browser for preview and testing.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `source` | string | Yes | Panel path or URL |
| `name` | string | No | Stable child name |
| `browser` | boolean | No | Launch as browser child |
| `context_id` | string | No | Shared storage context |

```
launch_panel({ source: "panels/my-app" })
launch_panel({ source: "https://example.com", browser: true })
```

The returned `id` can be used with `getCdpEndpoint()` via eval for Playwright automation:

```
eval({ code: `
  const { getCdpEndpoint } = await import("playwright");
  // Use the panel ID from launch_panel result
` })
```

### eval

Execute TypeScript/JavaScript code in the panel runtime.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `code` | string | Yes | Code to execute |
| `syntax` | `"typescript"` \| `"tsx"` \| `"jsx"` | No | Syntax mode (default: `"tsx"`) |
| `timeout` | number | No | Max async wait in ms (default: 10000, max: 90000) |

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

---

**Note:** The Bash tool is available as a fallback but prefer the structured tools above for safety and discoverability.
