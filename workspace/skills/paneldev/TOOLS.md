# Agent Tools Reference

Agents use native SDK tools (Bash, Read, Write, Edit, Glob, Grep, etc.) with the current working directory set to the context folder. All file paths are relative to the context folder root.

## Native SDK Tools

These are the standard tools provided by the agent SDK. They operate directly on the context folder filesystem.

### Bash

Execute shell commands. The working directory is the context folder.

```
Bash({ command: "ls panels/" })
Bash({ command: "git status" })
Bash({ command: "git add -A && git commit -m 'Update panel'" })
```

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

## PubSub Tools (Feedback, Eval, Type Checking)

These tools are provided via the NatStack pubsub channel for operations that require the panel runtime environment.

### Eval (eval)

Execute TypeScript/JavaScript code in the panel runtime.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `code` | string | Yes | Code to execute |
| `syntax` | `"typescript"` \| `"tsx"` \| `"jsx"` | No | Syntax mode (default: `"tsx"`) |
| `timeout` | number | No | Max async wait in ms (default: 10000, max: 90000) |

**Features:**
- Top-level await support
- Console output streaming
- Async operation tracking
- Safe serialization of return values

**Available Modules:**
- `fs`
- `react`, `react/jsx-runtime`
- `@radix-ui/themes`, `@radix-ui/react-icons`
- `isomorphic-git` (for advanced git operations)

---

### CheckTypes (check_types)

Run TypeScript diagnostics on a panel/worker.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `panel_path` | string | Yes | Root path of the panel/worker |
| `file_path` | string | No | Specific file to check |

### GetTypeInfo (get_type_info)

Get type information at a position.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `panel_path` | string | Yes | Root path of the panel/worker |
| `file_path` | string | Yes | Path to the file |
| `line` | number | Yes | Line number (1-indexed) |
| `column` | number | Yes | Column number (1-indexed) |

### GetCompletions (get_completions)

Get code completions at a position.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `panel_path` | string | Yes | Root path of the panel/worker |
| `file_path` | string | Yes | Path to the file |
| `line` | number | Yes | Line number (1-indexed) |
| `column` | number | Yes | Column number (1-indexed) |

---

### WebSearch (web_search)

Search the web for information.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `allowed_domains` | string[] | No | Only include results from these domains |
| `blocked_domains` | string[] | No | Exclude results from these domains |

### WebFetch (web_fetch)

Fetch and process content from a URL.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | string | Yes | URL to fetch |
| `prompt` | string | Yes | What to extract from the page |
