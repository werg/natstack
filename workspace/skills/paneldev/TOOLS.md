# Agent Tools Reference

Tools available in restricted mode. Names are PascalCase, arguments are snake_case.

## Workspace Discovery

### WorkspaceList (workspace_list)

List available repositories in the workspace.

**Parameters:**
| Name | Type | Default | Description |
|------|------|---------|-------------|
| `category` | `"panels"` \| `"workers"` \| `"contexts"` \| `"packages"` \| `"skills"` \| `"all"` | `"all"` | Filter by category |

**Returns:** Human-readable tree of available repos. Skills include their description from SKILL.md.

**Example:**
```
WorkspaceList({ category: "skills" })
```

**Skills:** Repos with a `SKILL.md` file are skills. The file has YAML frontmatter with `name` and `description`, followed by instructions for agents.

### WorkspaceClone (workspace_clone)

Clone a repository into your context's filesystem.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `repo_spec` | string | Yes | Repo spec like `"panels/editor"`, `"panels/editor#main"`, or `"panels/editor@v1.0.0"` |
| `mount_path` | string | No | Where to mount (default: `/workspace/<repo_path>`) |

**Returns:** Confirmation message with clone path and commit.

**Example:**
```
WorkspaceClone({ repo_spec: "panels/code-editor" })
```

**Note:** Cloned repos are push-enabled. You can commit and push changes.

### ContextInfo (context_info)

Show what repositories are currently mounted in your context.

**Parameters:** None

**Returns:** Human-readable list of mounted repos (with branch/commit when available).

**Example:**
```
ContextInfo()
```

**Note:** This tool scans common `/workspace/*` layouts and may not show custom mount paths.

### ContextTemplateList (context_template_list)

List available context templates in the workspace.

**Parameters:** None

**Returns:** List of template specs (e.g., `contexts/default`).

**Example:**
```
ContextTemplateList()
```

### ContextTemplateRead (context_template_read)

Read a context template's YAML configuration.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `template_spec` | string | Yes | Template spec like `"contexts/default"` |

**Returns:** Template YAML content (if present in context).

**Example:**
```
ContextTemplateRead({ template_spec: "contexts/default" })
```

**Note:** The template repo must be cloned into your context first. To discover templates, run `ContextTemplateList()` and then `WorkspaceClone` the template repo you want.

---

## File Operations

### Read (file_read)

Read file contents with optional pagination.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file_path` | string | Yes | Absolute path to the file |
| `offset` | number | No | Line number to start from (1-indexed, default: 1) |
| `limit` | number | No | Number of lines to read (default: 2000) |

### Write (file_write)

Create or overwrite a file.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file_path` | string | Yes | Absolute path to the file |
| `content` | string | Yes | File content |

### Edit (file_edit)

Edit a file using string replacement.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `file_path` | string | Yes | Absolute path to the file |
| `old_string` | string | Yes | Text to find |
| `new_string` | string | Yes | Replacement text |
| `replace_all` | boolean | No | Replace all occurrences (default: false) |

### Remove (rm)

Delete files or directories.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Path to delete |
| `recursive` | boolean | No | Delete directories recursively (default: false) |

---

## Search Tools

### Glob (glob)

Find files by glob pattern. Respects `.gitignore`.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pattern` | string | Yes | Glob pattern like `"**/*.ts"` |
| `path` | string | No | Directory to search (default: workspace root) |

### Grep (grep)

Search file contents with regex.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `pattern` | string | Yes | Regex pattern to search for |
| `path` | string | No | File or directory to search |
| `output_mode` | `"content"` \| `"files_with_matches"` \| `"count"` | No | Output mode (default: `"files_with_matches"`) |
| `glob` | string | No | Filter by glob pattern |
| `type` | string | No | Filter by file type (`"ts"`, `"js"`, `"py"`, etc.) |
| `-i` | boolean | No | Case insensitive search |
| `-n` | boolean | No | Show line numbers (default: true for content mode) |
| `-A` | number | No | Lines after match |
| `-B` | number | No | Lines before match |
| `-C` | number | No | Lines before and after match |
| `-w` | boolean | No | Match whole words only |
| `-F` | boolean | No | Fixed string matching |
| `head_limit` | number | No | Limit results |
| `offset` | number | No | Skip first N results |
| `multiline` | boolean | No | Enable multiline matching |

---

## Directory Tools

### Tree (tree)

Show ASCII directory structure.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | No | Root path (default: workspace root) |
| `depth` | number | No | Maximum depth (default: 3) |
| `show_hidden` | boolean | No | Include hidden files (default: false) |
| `dirs_only` | boolean | No | Only show directories (default: false) |

### ListDirectory (list_directory)

List directory contents like `ls -la`.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | Yes | Directory path |

---

## Git Tools

All git operations use isomorphic-git internally. Changes are automatically tracked and can be pushed.

### GitStatus (git_status)

Show repository status.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | No | Repo path (default: workspace root) |

### GitDiff (git_diff)

Show file changes in unified diff format.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | No | Repo path |
| `staged` | boolean | No | Show staged changes |
| `file` | string | No | Specific file to diff |

### GitLog (git_log)

Show commit history.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `path` | string | No | Repo path |
| `limit` | number | No | Max commits (default: 10) |
| `format` | `"oneline"` \| `"full"` | No | Output format (default: `"oneline"`) |

### GitAdd (git_add)

Stage files for commit.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `files` | string[] | Yes | Files to stage |
| `path` | string | No | Repo path |

**Note:** `files` are paths relative to the repo root.

### GitCommit (git_commit)

Create a commit.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `message` | string | Yes | Commit message |
| `path` | string | No | Repo path |

### GitCheckout (git_checkout)

Switch branches or restore files.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `branch` | string | No | Branch to checkout |
| `file` | string | No | File to restore |
| `create` | boolean | No | Create new branch |
| `path` | string | No | Repo path |

---

## Code Execution

### Eval (eval)

Execute TypeScript/JavaScript code.

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
- `fs` (OPFS shim in safe panels)
- `react`, `react/jsx-runtime`
- `@radix-ui/themes`, `@radix-ui/react-icons`
- `isomorphic-git` (for advanced git operations)

---

## Type Checking

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

## Web Tools

### WebSearch (web_search)

Search the web for information.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `query` | string | Yes | Search query |
| `allowed_domains` | string[] | No | Only include results from these domains |
| `blocked_domains` | string[] | No | Exclude results from these domains |

**Example:**
```
WebSearch({ query: "React hooks tutorial" })
```

### WebFetch (web_fetch)

Fetch and process content from a URL.

**Parameters:**
| Name | Type | Required | Description |
|------|------|----------|-------------|
| `url` | string | Yes | URL to fetch |
| `prompt` | string | Yes | What to extract from the page |

**Example:**
```
WebFetch({ url: "https://docs.example.com/api", prompt: "Extract the API endpoints" })
```

**Note:** Returns processed content based on your prompt. Handles HTML-to-markdown conversion automatically.
