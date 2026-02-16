/**
 * Responder Registry
 *
 * Maps agent IDs to their classes and manifests. These responders run in-process
 * in the main server, connected to pubsub via WebSocket.
 *
 * Previously these lived in workspace/agents/ and were dynamically built + spawned
 * as separate processes. Now they are trusted, first-party server code.
 */

import type { AgentManifest } from "@natstack/types";
import type { Agent, AgentState } from "@natstack/agent-runtime";
import { ClaudeCodeResponder } from "./claude-code-responder.js";
import { CodexResponderAgent } from "./codex-responder.js";
import { PubsubChatResponder } from "./pubsub-chat-responder.js";

/**
 * A registered responder: its agent class constructor and manifest metadata.
 */
export interface RegisteredResponder {
  AgentClass: new () => Agent<AgentState>;
  manifest: AgentManifest;
}

/**
 * Registry of all in-process responders.
 * Agent IDs must match the old workspace/agents/ directory names
 * for backward compatibility with channel_agents registrations and state DBs.
 */
export const RESPONDER_REGISTRY: ReadonlyMap<string, RegisteredResponder> = new Map([
  [
    "claude-code-responder",
    {
      AgentClass: ClaudeCodeResponder as unknown as new () => Agent<AgentState>,
      manifest: {
        id: "claude-code-responder",
        name: "Claude Code Responder",
        version: "0.1.0",
        title: "Claude Code Responder",
        description:
          "AI-powered code assistant using the Claude Agent SDK with full tool support",
        channels: ["chat:*"],
        parameters: [
          {
            key: "workingDirectory",
            label: "Working Directory",
            type: "string",
            channelLevel: true,
          },
          {
            key: "model",
            label: "Model",
            type: "select",
            default: "claude-opus-4-6",
            options: [
              { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
              { value: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
              { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
            ],
          },
          {
            key: "maxThinkingTokens",
            label: "Max Thinking Tokens",
            type: "slider",
            default: 10240,
            min: 0,
            max: 32000,
            step: 1024,
          },
          {
            key: "executionMode",
            label: "Execution Mode",
            type: "segmented",
            default: "edit",
            options: [
              { value: "plan", label: "Plan" },
              { value: "edit", label: "Edit" },
            ],
          },
          {
            key: "autonomyLevel",
            label: "Autonomy Level",
            type: "slider",
            default: 0,
            min: 0,
            max: 2,
            step: 1,
          },
          {
            key: "restrictedMode",
            label: "Restricted Mode",
            type: "boolean",
            channelLevel: true,
          },
        ],
      },
    },
  ],
  [
    "codex-responder",
    {
      AgentClass: CodexResponderAgent as unknown as new () => Agent<AgentState>,
      manifest: {
        id: "codex-responder",
        name: "Codex Responder",
        version: "0.1.0",
        title: "Codex Responder",
        description:
          "AI-powered code assistant using the OpenAI Codex SDK with MCP tool bridge",
        channels: ["chat:*"],
        parameters: [
          {
            key: "workingDirectory",
            label: "Working Directory",
            type: "string",
            channelLevel: true,
          },
          {
            key: "model",
            label: "Model",
            type: "select",
            default: "gpt-5.3-codex",
            options: [
              { value: "gpt-5.3-codex", label: "GPT 5.3 Codex" },
              { value: "o4-mini", label: "o4-mini" },
              { value: "o3", label: "o3" },
            ],
          },
          {
            key: "reasoningEffort",
            label: "Reasoning Effort",
            type: "slider",
            default: 2,
            min: 0,
            max: 3,
            step: 1,
          },
          {
            key: "autonomyLevel",
            label: "Autonomy Level",
            type: "slider",
            default: 0,
            min: 0,
            max: 2,
            step: 1,
          },
          {
            key: "webSearchEnabled",
            label: "Web Search",
            type: "boolean",
            default: true,
          },
          {
            key: "restrictedMode",
            label: "Restricted Mode",
            type: "boolean",
            channelLevel: true,
          },
        ],
      },
    },
  ],
  [
    "pubsub-chat-responder",
    {
      AgentClass: PubsubChatResponder as unknown as new () => Agent<AgentState>,
      manifest: {
        id: "pubsub-chat-responder",
        name: "AI Chat Responder",
        version: "0.1.0",
        title: "AI Chat Responder",
        description:
          "AI-powered chat responder with tool support and agentic capabilities",
        channels: ["chat:*"],
        parameters: [
          {
            key: "modelRole",
            label: "Model Role",
            type: "select",
            default: "smart",
            options: [
              { value: "fast", label: "Fast" },
              { value: "smart", label: "Smart" },
              { value: "coding", label: "Coding" },
            ],
          },
          {
            key: "temperature",
            label: "Temperature",
            type: "slider",
            default: 0.7,
            min: 0,
            max: 2,
            step: 0.1,
          },
          {
            key: "maxOutputTokens",
            label: "Max Output Tokens",
            type: "slider",
            default: 2048,
            min: 256,
            max: 4096,
            step: 256,
          },
          {
            key: "autonomyLevel",
            label: "Autonomy Level",
            type: "slider",
            default: 0,
            min: 0,
            max: 2,
            step: 1,
          },
          {
            key: "maxSteps",
            label: "Max Steps",
            type: "slider",
            default: 10,
            min: 1,
            max: 20,
            step: 1,
          },
          {
            key: "thinkingBudget",
            label: "Thinking Budget",
            type: "slider",
            default: 0,
            min: 0,
            max: 32000,
            step: 1024,
          },
        ],
      },
    },
  ],
]);
