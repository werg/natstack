/**
 * Agent Manager Panel
 *
 * Acts as a broker in the agent discovery system.
 * Advertises available agent types on the availability channel and spawns
 * workers when clients send invites.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import {
  Box,
  Card,
  Flex,
  Text,
  Heading,
  Badge,
  Button,
  ScrollArea,
  Code,
} from "@radix-ui/themes";
import { createChild, pubsubConfig, type ChildHandle } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import {
  connectAsBroker,
  type BrokerClient,
  type AgentTypeAdvertisement,
  type Invite,
} from "@natstack/agentic-messaging";

const AVAILABILITY_CHANNEL = "agent-availability";

/** Agent type definitions */
const AGENT_TYPES: AgentTypeAdvertisement[] = [
  {
    id: "ai-responder",
    name: "AI Responder",
    proposedHandle: "ai",
    description: "Fast AI assistant using NatStack AI SDK. Good for quick, helpful responses.",
    providesMethods: [],
    requiresMethods: [],
    parameters: [],
    tags: ["chat", "ai", "fast"],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    proposedHandle: "claude",
    description:
      "Claude-based agent with access to tools from other participants. Can use discovered tools to help with complex tasks.",
    providesMethods: [],
    requiresMethods: [],
    parameters: [
      {
        key: "workingDirectory",
        label: "Working Directory",
        description: "The directory where Claude Code will operate. Leave empty for default.",
        type: "string",
        required: false,
        placeholder: "/path/to/project",
      },
    ],
    tags: ["chat", "coding", "tools", "claude"],
  },
  {
    id: "codex",
    name: "Codex",
    proposedHandle: "codex",
    description:
      "OpenAI Codex agent with MCP tool support. Specialized for code-related tasks with tool access.",
    providesMethods: [],
    requiresMethods: [],
    parameters: [
      {
        key: "workingDirectory",
        label: "Working Directory",
        description: "The directory where Codex will operate. Leave empty for default.",
        type: "string",
        required: false,
        placeholder: "/path/to/project",
      },
    ],
    tags: ["chat", "coding", "tools", "openai"],
  },
];

/** Map agent type ID to worker source */
function getWorkerSource(agentTypeId: string): string {
  switch (agentTypeId) {
    case "ai-responder":
      return "workers/pubsub-chat-responder";
    case "claude-code":
      return "workers/claude-code-responder";
    case "codex":
      return "workers/codex-responder";
    default:
      throw new Error(`Unknown agent type: ${agentTypeId}`);
  }
}

/** Log entry for invite history */
interface InviteLogEntry {
  id: string;
  timestamp: Date;
  agentTypeId: string;
  targetChannel: string;
  senderId: string;
  accepted: boolean;
  error?: string;
  /** Full invite config for inspection */
  config?: Record<string, unknown>;
}

/** Active agent tracking */
interface ActiveAgent {
  id: string;
  agentTypeId: string;
  channel: string;
  handle: ChildHandle;
  startedAt: Date;
  /** Config passed to this agent */
  config?: Record<string, unknown>;
}

/** Collapsible JSON viewer component */
function JsonInspector({ data, label }: { data: unknown; label?: string }) {
  const [expanded, setExpanded] = useState(false);

  if (data === undefined || data === null || (typeof data === "object" && Object.keys(data as object).length === 0)) {
    return null;
  }

  return (
    <Flex direction="column" gap="1" style={{ fontSize: "11px" }}>
      <Text
        size="1"
        color="gray"
        style={{ cursor: "pointer", userSelect: "none" }}
        onClick={() => setExpanded(!expanded)}
      >
        {expanded ? "▼" : "▶"} {label || "Details"}
      </Text>
      {expanded && (
        <Code
          size="1"
          style={{
            display: "block",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            padding: "8px",
            backgroundColor: "var(--gray-3)",
            borderRadius: "4px",
            maxHeight: "150px",
            overflow: "auto",
          }}
        >
          {JSON.stringify(data, null, 2)}
        </Code>
      )}
    </Flex>
  );
}

export default function AgentManager() {
  const theme = usePanelTheme();
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Initializing...");
  const [activeAgents, setActiveAgents] = useState<ActiveAgent[]>([]);
  const [inviteLog, setInviteLog] = useState<InviteLogEntry[]>([]);

  const brokerRef = useRef<BrokerClient | null>(null);
  const activeAgentsRef = useRef<ActiveAgent[]>([]);

  const addLogEntry = useCallback((entry: Omit<InviteLogEntry, "id" | "timestamp">) => {
    setInviteLog((prev) => [
      {
        ...entry,
        id: crypto.randomUUID(),
        timestamp: new Date(),
      },
      ...prev.slice(0, 49), // Keep last 50 entries
    ]);
  }, []);

  const stopAgent = useCallback(async (agentId: string) => {
    setActiveAgents((prev) => {
      const agent = prev.find((a) => a.id === agentId);
      if (agent) {
        void agent.handle.close();
      }
      return prev.filter((a) => a.id !== agentId);
    });
  }, []);

  // Initialize broker connection
  useEffect(() => {
    if (!pubsubConfig) {
      setStatus("Error: PubSub not available");
      return;
    }

    let mounted = true;

    async function init() {
      setStatus("Connecting to availability channel...");

      try {
        const broker = await connectAsBroker(pubsubConfig!.serverUrl, pubsubConfig!.token, {
          availabilityChannel: AVAILABILITY_CHANNEL,
          name: "Agent Manager",
          handle: "agent-manager",
          agentTypes: AGENT_TYPES,
          onInvite: async (invite: Invite, senderId: string) => {
            console.log(`[Agent Manager] Received invite from ${senderId} for ${invite.agentTypeId}`);
            // Accept all invites - spawn will happen in onSpawn
            return { accept: true };
          },
          onSpawn: async (invite: Invite, agentType: AgentTypeAdvertisement) => {
            console.log(`[Agent Manager] Spawning ${agentType.id} for channel ${invite.targetChannel}`);
            console.log(`[Agent Manager] Config:`, invite.config);

            try {
              const workerSource = getWorkerSource(agentType.id);
              const workerName = `${agentType.id}-${invite.targetChannel.slice(0, 8)}`;

              // Determine the handle: use override if provided, otherwise use proposed handle
              const agentHandle = invite.handleOverride ?? agentType.proposedHandle;

              // Build environment from channel + serialized config (including handle)
              const agentConfig = {
                ...invite.config,
                handle: agentHandle,
              };
              const env: Record<string, string> = {
                CHANNEL: invite.targetChannel,
                // Serialize all config parameters into a single JSON env var
                AGENT_CONFIG: JSON.stringify(agentConfig),
              };

              console.log(`[Agent Manager] Spawning with env:`, env);

              const handle = await createChild(workerSource, { name: workerName, env });

              // Track the active agent
              const activeAgent: ActiveAgent = {
                id: handle.id,
                agentTypeId: agentType.id,
                channel: invite.targetChannel,
                handle,
                startedAt: new Date(),
                config: invite.config,
              };

              if (mounted) {
                setActiveAgents((prev) => [...prev, activeAgent]);
                addLogEntry({
                  agentTypeId: agentType.id,
                  targetChannel: invite.targetChannel,
                  senderId: invite.inviteId, // Use inviteId as sender reference
                  accepted: true,
                  config: invite.config,
                });
              }

              return { agentId: handle.id };
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              console.error(`[Agent Manager] Failed to spawn agent:`, err);

              if (mounted) {
                addLogEntry({
                  agentTypeId: agentType.id,
                  targetChannel: invite.targetChannel,
                  senderId: invite.inviteId,
                  accepted: false,
                  error: errorMsg,
                  config: invite.config,
                });
              }

              throw err;
            }
          },
        });

        brokerRef.current = broker;

        if (mounted) {
          setConnected(true);
          setStatus("Connected");
        }
      } catch (err) {
        if (mounted) {
          setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    void init();

    return () => {
      mounted = false;
      if (brokerRef.current) {
        void brokerRef.current.close();
      }
      brokerRef.current = null;
    };
  }, [addLogEntry]);

  // Keep active agent list available for unmount cleanup
  useEffect(() => {
    activeAgentsRef.current = activeAgents;
  }, [activeAgents]);

  // Cleanup agents on unmount
  useEffect(() => {
    return () => {
      for (const agent of activeAgentsRef.current) {
        void agent.handle.close();
      }
    };
  }, []);

  return (
    <Box
      p="4"
      style={{
        height: "100vh",
        backgroundColor: theme === "dark" ? "var(--gray-1)" : "var(--gray-2)",
      }}
    >
      <Flex direction="column" gap="4" style={{ height: "100%" }}>
        {/* Header */}
        <Flex justify="between" align="center">
          <Heading size="5">Agent Manager</Heading>
          <Badge color={connected ? "green" : "gray"} variant="soft">
            {connected ? "Connected" : status}
          </Badge>
        </Flex>

        {/* Agent Types */}
        <Card>
          <Flex direction="column" gap="3">
            <Text weight="medium" size="2" color="gray">
              Advertised Agent Types ({AGENT_TYPES.length})
            </Text>
            <Flex direction="column" gap="2">
              {AGENT_TYPES.map((agentType) => (
                <Card key={agentType.id} variant="surface">
                  <Flex direction="column" gap="2">
                    <Flex justify="between" align="start" gap="3">
                      <Flex direction="column" gap="1">
                        <Text weight="medium">{agentType.name}</Text>
                        <Text size="1" color="gray">
                          {agentType.description}
                        </Text>
                        <Flex gap="1" wrap="wrap" mt="1">
                          {agentType.tags?.map((tag) => (
                            <Badge key={tag} size="1" variant="outline">
                              {tag}
                            </Badge>
                          ))}
                        </Flex>
                      </Flex>
                      <Badge size="1" color="gray">{agentType.id}</Badge>
                    </Flex>
                    <JsonInspector
                      data={{
                        parameters: agentType.parameters,
                        providesMethods: agentType.providesMethods,
                        requiresMethods: agentType.requiresMethods,
                      }}
                      label="View metadata"
                    />
                  </Flex>
                </Card>
              ))}
            </Flex>
          </Flex>
        </Card>

        {/* Active Agents */}
        <Card style={{ flex: 1, minHeight: 0 }}>
          <Flex direction="column" gap="3" style={{ height: "100%" }}>
            <Flex justify="between" align="center">
              <Text weight="medium" size="2" color="gray">
                Active Agents ({activeAgents.length})
              </Text>
            </Flex>
            <ScrollArea style={{ flex: 1 }}>
              {activeAgents.length === 0 ? (
                <Text size="2" color="gray">
                  No active agents. Agents will appear here when clients invite them.
                </Text>
              ) : (
                <Flex direction="column" gap="2">
                  {activeAgents.map((agent) => (
                    <Card key={agent.id} variant="surface">
                      <Flex direction="column" gap="2">
                        <Flex justify="between" align="center">
                          <Flex direction="column" gap="1">
                            <Text size="2" weight="medium">
                              {AGENT_TYPES.find((t) => t.id === agent.agentTypeId)?.name || agent.agentTypeId}
                            </Text>
                            <Text size="1" color="gray">
                              Channel: {agent.channel}
                            </Text>
                            <Text size="1" color="gray">
                              Started: {agent.startedAt.toLocaleTimeString()}
                            </Text>
                          </Flex>
                          <Flex gap="2" align="center">
                            <Badge color="green" variant="soft">
                              Running
                            </Badge>
                            <Button size="1" variant="soft" color="red" onClick={() => stopAgent(agent.id)}>
                              Stop
                            </Button>
                          </Flex>
                        </Flex>
                        <JsonInspector
                          data={{
                            id: agent.id,
                            agentTypeId: agent.agentTypeId,
                            channel: agent.channel,
                            config: agent.config,
                          }}
                          label="View details"
                        />
                      </Flex>
                    </Card>
                  ))}
                </Flex>
              )}
            </ScrollArea>
          </Flex>
        </Card>

        {/* Invite Log */}
        <Card style={{ maxHeight: "300px" }}>
          <Flex direction="column" gap="2">
            <Text weight="medium" size="2" color="gray">
              Invite Log ({inviteLog.length})
            </Text>
            <ScrollArea style={{ maxHeight: "250px" }}>
              {inviteLog.length === 0 ? (
                <Text size="1" color="gray">
                  No invites yet.
                </Text>
              ) : (
                <Flex direction="column" gap="2">
                  {inviteLog.map((entry) => (
                    <Card
                      key={entry.id}
                      variant="surface"
                      style={{
                        borderLeft: entry.accepted
                          ? "3px solid var(--green-9)"
                          : "3px solid var(--red-9)",
                      }}
                    >
                      <Flex direction="column" gap="1">
                        <Flex justify="between" align="center">
                          <Flex gap="2" align="center">
                            <Badge color={entry.accepted ? "green" : "red"} size="1">
                              {entry.accepted ? "✓ Accepted" : "✗ Failed"}
                            </Badge>
                            <Text size="1" weight="medium">
                              {AGENT_TYPES.find((t) => t.id === entry.agentTypeId)?.name || entry.agentTypeId}
                            </Text>
                          </Flex>
                          <Text size="1" color="gray">
                            {entry.timestamp.toLocaleTimeString()}
                          </Text>
                        </Flex>
                        <Text size="1" color="gray">
                          Channel: {entry.targetChannel}
                        </Text>
                        {entry.error && (
                          <Card
                            variant="surface"
                            style={{
                              backgroundColor: "var(--red-3)",
                              padding: "8px",
                            }}
                          >
                            <Text size="1" color="red" weight="medium">
                              Error: {entry.error}
                            </Text>
                          </Card>
                        )}
                        <JsonInspector
                          data={{
                            inviteId: entry.senderId,
                            agentTypeId: entry.agentTypeId,
                            targetChannel: entry.targetChannel,
                            config: entry.config,
                            error: entry.error,
                          }}
                          label="View full details"
                        />
                      </Flex>
                    </Card>
                  ))}
                </Flex>
              )}
            </ScrollArea>
          </Flex>
        </Card>
      </Flex>
    </Box>
  );
}
