---
name: agents
description: Discover, spawn, and manage personality-driven agents from workspace/agents/ manifests.
---

# Personality Agents

Manage personality-driven agents defined in `workspace/agents/`.

## Agent Definition

Two ways to define agents:

### Simple: Registry file (`workspace/agents/agents.yml`)

Best for agents that are just a personality + config. All agents in one file:

```yaml
agents:
  - name: "Aria"
    handle: "aria"
    personality: |
      You are Aria, a warm and empathetic assistant.
    model: smart
    temperature: 0.7
    tools: [eval, set_title]
    greeting: "Hi! I'm Aria. How can I help?"

  - name: "Rex"
    handle: "rex"
    personality: |
      You are Rex, a terse systems engineer. No fluff.
    model: smart
    temperature: 0.3
    tools: [eval, set_title]
```

### Complex: Per-directory (`workspace/agents/{name}/agent.yml`)

For agents that need supplementary files (extended SOUL docs, knowledge bases, custom assets):

```
workspace/agents/aria/
  agent.yml          # Manifest
  SOUL.md            # Extended personality (referenced from personality field)
  knowledge/         # Domain files the agent can reference
```

Per-directory manifests override registry entries with the same handle.

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
