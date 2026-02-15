# OPFS and Storage Partitions

This document explains how Origin Private File System (OPFS) storage isolation works for NatStack panels, including the **context template system** for efficiently creating pre-populated agentic sandboxes.

## What is OPFS?

OPFS (Origin Private File System) is a browser storage API that provides a private file system for web applications. In Electron, OPFS is scoped to the **session partition**, so different partitions get different storage.

## Context Templates: Docker-Like Sandboxes for Agents

NatStack's context template system enables **efficient creation of shared agentic contexts**. Think of it like Docker for panel sandboxes:

1. **Define a template** specifying git repositories to clone into specific paths
2. **Build once**: The template is built to OPFS by a background worker
3. **Copy many**: Each new context partition copies from the pre-built template

This is particularly valuable for **agentic workloads** where multiple AI agents need the same base environment (tools, libraries, data) but with isolated working directories.

### Why Templates?

Without templates, every new agent session would need to:
- Clone the same repositories
- Download the same dependencies
- Set up the same file structure

With templates, this setup happens **once**, and each new session gets an instant copy of the pre-built environment.

## Context ID Formats

NatStack uses two context ID formats:

### Safe Panels (Template-Based)

```
safe_tpl_{templateSpecHash}_{instanceId}
```

- **safe_tpl_**: Prefix indicating a safe, sandboxed panel with template initialization
- **templateSpecHash**: 12-character hash of the template specification (ensures consistency)
- **instanceId**: Unique identifier for this instance (derived from panel ID)

Example: `safe_tpl_a1b2c3d4e5f6_panels~editor`

### Unsafe Panels (No Template)

```
unsafe_noctx_{instanceId}
```

- **unsafe_noctx_**: Prefix indicating an unsafe panel without template initialization
- **instanceId**: Unique identifier for this instance

Example: `unsafe_noctx_panels~terminal`

**Note**: `unsafe_tpl_*` is **invalid** - unsafe panels cannot use templates because they have Node.js filesystem access and don't use OPFS.

## Creating Context Templates

Templates are defined in `context-template.yml` files:

```yaml
# contexts/my-agent/context-template.yml

# Optional: inherit from another template
extends: contexts/base-tools

# Git repositories to clone into the context
deps:
  /tools/search:
    repo: tools/web-search
    ref: main
  /tools/calculator:
    repo: tools/calculator
    ref: v1.2.0
  /data/prompts:
    repo: shared/prompt-library
    ref: main
```

### Template Fields

| Field | Description |
|-------|-------------|
| `extends` | Optional parent template to inherit from (like Docker's `FROM`) |
| `deps` | Map of target paths to git repository specs |

### Repository Specs

Each dependency specifies:
- **Target path**: Where to clone in the OPFS filesystem (e.g., `/tools/search`)
- **repo**: Git repository path (relative to git server)
- **ref**: Git ref (branch, tag, or commit SHA)

### Template Inheritance

Templates can extend other templates, creating a layered system:

```yaml
# contexts/base-tools/context-template.yml
deps:
  /tools/core:
    repo: tools/core-utils
    ref: main

# contexts/agent-v2/context-template.yml
extends: contexts/base-tools
deps:
  /tools/ai:
    repo: tools/ai-helpers
    ref: v2.0.0
  # Inherits /tools/core from base-tools
```

### Conflict Detection

If two templates in the inheritance chain specify the same path with different repos/refs, NatStack will raise a `TemplateConflictError`. This prevents accidental overwrites.

## Using Templates in Panels

### Panel with Template

Specify a `templateSpec` in your panel's directory:

```
panels/my-agent/
  ├── package.json
  ├── index.tsx
  └── context-template.yml   # Template for this panel's context
```

When the panel loads:
1. NatStack resolves the template (following `extends` chains)
2. Computes a hash of the final template specification
3. Checks if that template has been built
4. If not, builds it via a background worker (cloning all repos to OPFS)
5. Copies the template partition to the panel's context partition
6. Panel code runs with the pre-populated filesystem

### Accessing Pre-Cloned Repos

```tsx
import { promises as fs } from "fs";

export default function MyAgentPanel() {
  const loadTools = async () => {
    // These paths were populated by the template!
    const searchTool = await fs.readFile("/tools/search/index.js", "utf-8");
    const prompts = await fs.readdir("/data/prompts");
    console.log("Available prompts:", prompts);
  };

  return <button onClick={loadTools}>Load Tools</button>;
}
```

## Getting Context Info

### From React

```tsx
import { usePanelPartition } from "@workspace/react";

function MyPanel() {
  const partition = usePanelPartition(); // string | null (loading)
  return <div>Storage: {partition ?? "loading..."}</div>;
}
```

### From Runtime

```ts
import { getInfo, contextId } from "@workspace/runtime";

console.log(contextId);  // e.g. "safe_tpl_a1b2c3d4e5f6_panels~editor"
const { partition } = await getInfo();
```

### Parsing Context IDs

```ts
import { parseContextId } from "@workspace/runtime";

const parsed = parseContextId("safe_tpl_a1b2c3d4e5f6_panels~editor");
// { mode: "safe", templateSpecHash: "a1b2c3d4e5f6", instanceId: "panels~editor" }

const unsafe = parseContextId("unsafe_noctx_panels~terminal");
// { mode: "unsafe", templateSpecHash: null, instanceId: "panels~terminal" }
```

## Context Behavior by Panel Type

### Safe Panels (Default)

- Use OPFS for storage
- Can use context templates
- Storage is isolated per context partition
- Context ID format: `safe_tpl_{hash}_{instanceId}`

### Unsafe Panels

- Use native Node.js filesystem
- Cannot use context templates
- Storage is in `context-scopes/` directory
- Context ID format: `unsafe_noctx_{instanceId}`

### Browser Panels

- Use default Electron session (for cookies/auth compatibility)
- Do not use context partitions
- No template support

## Template Build Process

When a template needs to be built:

1. **Resolve**: Follow `extends` chain, merge all `deps`
2. **Hash**: Compute SHA256 of the final specification
3. **Check Cache**: Look for existing build with that hash
4. **Build** (if needed):
   - Launch a hidden worker in a template partition
   - Clone each repository to its target path
   - Write a `.template-ready` marker file
5. **Copy**: Copy the template partition to the context partition

This ensures:
- Templates are only built once per unique specification
- Multiple panels with the same template share the build
- Changes to templates trigger rebuilds (hash changes)

## Implementation Details

- Safe panels use `partition: persist:${contextId}` in Electron
- Template builds happen in `src/builtin-workers/template-builder/`
- Template metadata is stored in `template-builds/` directory
- Context partitions are stored in `partitions/` directory
- The system uses file locks to prevent concurrent builds

## Security Considerations

- Each context partition is isolated at the Chromium level
- Context mode (`safe`/`unsafe`) is encoded in the ID and validated
- Safe panels cannot use unsafe contexts (prevents privilege escalation)
- OPFS is origin-private and partition-private
- Context isolation and sandboxing are enabled for safe panels
- Template builds run in isolated workers without Node.js access
