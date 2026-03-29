---
name: agents
description: Discover, spawn, and manage personality-driven agents from workspace/agents/ manifests.
---

# Personality Agents

Manage personality-driven agents defined in `workspace/agents/`.

## Agent Definition

Each agent is a directory under `workspace/agents/` containing an `agent.yml` manifest:

```
workspace/agents/aria/
  agent.yml          # Required — personality manifest
  SOUL.md            # Optional — extended personality docs
  knowledge/         # Optional — domain-specific context files
```

Example `agent.yml`:

```yaml
name: "Aria"
handle: "aria"
personality: |
  You are Aria, a warm and empathetic assistant.
  You speak in a friendly but professional tone.
model: smart
temperature: 0.7
tools: [eval, set_title]
greeting: "Hi! I'm Aria. How can I help?"
memory:
  enabled: true
  categories: [preferences, facts]
```

## Quick Start

```typescript
import { AgentRegistry } from "@workspace-skills/agents";

const registry = new AgentRegistry();
await registry.discover();                              // Scan workspace/agents/
console.log(registry.available());                      // List discovered agents
const agent = await registry.spawn("aria", channelId);  // Spawn + subscribe to channel
```

## API Reference

| Method | Description |
|--------|-------------|
| `discover()` | Scan `workspace/agents/` for manifests (registry file + per-directory) |
| `spawn(handle, channelId)` | Create a PersonalityAgentWorker DO and subscribe to channel |
| `subscribe(handle, channelId)` | Add existing agent to another channel |
| `list()` | List spawned agent instances |
| `available()` | List discovered but not-yet-spawned agent manifests |
| `remove(handle)` | Unsubscribe from all channels and destroy agent DO |

## Agent Manifest Fields

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `name` | yes | — | Display name |
| `handle` | yes | — | @-mention identifier (must be unique) |
| `personality` | yes | — | System prompt — the agent's "SOUL" |
| `systemPromptMode` | no | `replace-natstack` | How personality layers with base prompt |
| `model` | no | workspace default | Model role (`smart`, `fast`, etc.) or specific model ID |
| `temperature` | no | model default | Sampling temperature (0-2) |
| `maxTokens` | no | model default | Maximum output tokens |
| `tools` | no | `[eval, set_title]` | Tool allowlist |
| `greeting` | no | — | Proactive greeting sent when agent joins a channel |
| `memory.enabled` | no | `false` | Enable persistent cross-session memory |
| `memory.categories` | no | `[general]` | Memory categories for organization |

## Memory

Agents with `memory.enabled: true` have persistent memory across sessions via these methods:

- **remember(key, value, category)** — Store a fact
- **recall(key)** — Retrieve a specific fact
- **search_memory(query, category, limit)** — Search memories by substring
- **forget(key)** — Delete a memory entry

Memory survives DO hibernation, restarts, and even fork operations. It's stored in the DO's SQLite database.

## Architecture

Each spawned agent is a `PersonalityAgentWorker` Durable Object that:
- Extends `AiChatWorker` (inherits event handling, crash recovery, approval flow, turn queuing)
- Gets its identity entirely from subscription config (no hardcoded personality)
- Advertises memory methods as MCP tools (discovered by the harness via `discover-methods`)
- Supports proactive greetings on channel join
