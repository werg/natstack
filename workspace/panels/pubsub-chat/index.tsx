/**
 * Agentic Messaging Chat Demo Panel
 *
 * Demonstrates @natstack/agentic-messaging with the broker discovery system.
 * Uses connectForDiscovery to find available agents and invite them to a dynamic channel.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { Button, Card, Flex, Text, TextField, ScrollArea, Box, Badge, Checkbox, Select } from "@radix-ui/themes";
import { pubsubConfig, id as clientId } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import {
  connect,
  connectForDiscovery,
  type AgenticClient,
  type AgenticParticipantMetadata,
  type IncomingMessage,
  type Participant,
  type RosterUpdate,
  type BrokerDiscoveryClient,
  type DiscoveredBroker,
  type AgentTypeAdvertisement,
} from "@natstack/agentic-messaging";

const AVAILABILITY_CHANNEL = "agent-availability";

/**
 * Chat message as stored locally.
 */
interface ChatMessage {
  id: string;
  senderId: string;
  content: string;
  complete?: boolean;
  replyTo?: string;
  error?: string;
  pending?: boolean;
}

/** Metadata for participants in this channel */
interface ChatParticipantMetadata extends AgenticParticipantMetadata {
  name: string;
  type: "panel" | "ai-responder" | "claude-code" | "codex";
}

type AppPhase = "setup" | "connecting" | "chat";

/** Agent selection state */
interface AgentSelection {
  broker: DiscoveredBroker;
  agentType: AgentTypeAdvertisement;
  selected: boolean;
  /** Parameter values configured by user */
  config: Record<string, string | number | boolean>;
}

export default function AgenticChatDemo() {
  const theme = usePanelTheme();
  const workspaceRoot = process.env["NATSTACK_WORKSPACE"]?.trim();
  const [phase, setPhase] = useState<AppPhase>("setup");

  // Setup phase state
  const [availableAgents, setAvailableAgents] = useState<AgentSelection[]>([]);
  const [discoveryStatus, setDiscoveryStatus] = useState("Connecting to discovery...");

  // Chat phase state
  const [channelId, setChannelId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Initializing...");
  const [participants, setParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});

  const discoveryRef = useRef<BrokerDiscoveryClient | null>(null);
  const clientRef = useRef<AgenticClient<ChatParticipantMetadata> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Connect to discovery channel on mount
  useEffect(() => {
    if (!pubsubConfig) {
      setDiscoveryStatus("Error: PubSub not available");
      return;
    }

    let mounted = true;

    async function initDiscovery() {
      try {
        const discovery = await connectForDiscovery(pubsubConfig!.serverUrl, pubsubConfig!.token, {
          availabilityChannel: AVAILABILITY_CHANNEL,
          name: "Chat Panel",
          type: "panel",
        });

        if (!mounted) {
          discovery.close();
          return;
        }

        discoveryRef.current = discovery;

        // Initial broker discovery
        updateAvailableAgents(discovery);

        // Subscribe to changes
        discovery.onBrokersChanged(() => {
          if (mounted) {
            updateAvailableAgents(discovery);
          }
        });

        setDiscoveryStatus("Connected to discovery");
      } catch (err) {
        if (mounted) {
          setDiscoveryStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    function updateAvailableAgents(discovery: BrokerDiscoveryClient) {
      const brokers = discovery.discoverBrokers();
      const agents: AgentSelection[] = [];

      for (const broker of brokers) {
        for (const agentType of broker.agentTypes) {
          // Build default config from parameter definitions
          const defaultConfig: Record<string, string | number | boolean> = {};
          for (const param of agentType.parameters ?? []) {
            if (param.default !== undefined) {
              defaultConfig[param.key] = param.default;
            } else if (param.key === "workingDirectory" && workspaceRoot) {
              defaultConfig[param.key] = workspaceRoot;
            }
          }

          agents.push({
            broker,
            agentType,
            selected: false,
            config: defaultConfig,
          });
        }
      }

      setAvailableAgents((prev) => {
        // Preserve selection state and config for agents that still exist
        return agents.map((agent) => {
          const existing = prev.find(
            (p) => p.broker.brokerId === agent.broker.brokerId && p.agentType.id === agent.agentType.id
          );
          return existing ? { ...agent, selected: existing.selected, config: existing.config } : agent;
        });
      });
    }

    void initDiscovery();

    return () => {
      mounted = false;
      discoveryRef.current?.close();
      discoveryRef.current = null;
    };
  }, []);

  const toggleAgentSelection = useCallback((brokerId: string, agentTypeId: string) => {
    setAvailableAgents((prev) =>
      prev.map((agent) =>
        agent.broker.brokerId === brokerId && agent.agentType.id === agentTypeId
          ? { ...agent, selected: !agent.selected }
          : agent
      )
    );
  }, []);

  const updateAgentConfig = useCallback(
    (brokerId: string, agentTypeId: string, key: string, value: string | number | boolean) => {
      setAvailableAgents((prev) =>
        prev.map((agent) =>
          agent.broker.brokerId === brokerId && agent.agentType.id === agentTypeId
            ? { ...agent, config: { ...agent.config, [key]: value } }
            : agent
        )
      );
    },
    []
  );

  const buildInviteConfig = useCallback((agent: AgentSelection) => {
    const filteredConfig: Record<string, string | number | boolean> = {};

    for (const param of agent.agentType.parameters ?? []) {
      const value = agent.config[param.key];
      if (value !== undefined && value !== "") {
        filteredConfig[param.key] = value;
      } else if (param.default !== undefined) {
        filteredConfig[param.key] = param.default;
      }
    }

    return filteredConfig;
  }, []);

  const startChat = useCallback(async () => {
    const discovery = discoveryRef.current;
    if (!discovery || !pubsubConfig) return;

    const selectedAgents = availableAgents.filter((a) => a.selected);
    if (selectedAgents.length === 0) {
      setStatus("Please select at least one agent");
      return;
    }

    // Validate required parameters before sending invites
    const validationErrors: string[] = [];
    for (const agent of selectedAgents) {
      const requiredParams = agent.agentType.parameters?.filter((p) => p.required) ?? [];
      for (const param of requiredParams) {
        const value = agent.config[param.key];
        const hasValue = value !== undefined && value !== "";
        const hasDefault = param.default !== undefined;
        if (!hasValue && !hasDefault) {
          validationErrors.push(`${agent.agentType.name}: "${param.label}" is required`);
        }
      }
    }

    if (validationErrors.length > 0) {
      setStatus(`Missing required parameters:\n${validationErrors.join("\n")}`);
      return;
    }

    setPhase("connecting");
    setStatus("Creating channel and inviting agents...");

    // Generate unique channel ID
    const newChannelId = `chat-${crypto.randomUUID().slice(0, 8)}`;
    setChannelId(newChannelId);

    try {
      // Invite all selected agents with their configured parameters
      const invitePromises = selectedAgents.map(async (agent) => {
        const filteredConfig = buildInviteConfig(agent);

        try {
          const result = discovery.invite(agent.broker.brokerId, agent.agentType.id, newChannelId, {
            context: "User wants to chat",
            config: filteredConfig,
          });
          const response = await result.response;
          return { agent, response, error: null };
        } catch (err) {
          // Capture invite errors per-agent
          const errorMsg = err instanceof Error ? err.message : String(err);
          return {
            agent,
            response: null,
            error: errorMsg,
          };
        }
      });

      const results = await Promise.all(invitePromises);

      // Separate successful and failed invites
      const succeeded = results.filter((r) => r.response?.accepted);
      const declined = results.filter((r) => r.response && !r.response.accepted);
      const errored = results.filter((r) => r.error !== null);

      // Check if all invites failed
      if (succeeded.length === 0) {
        // Build detailed error message
        const errorParts: string[] = [];

        if (errored.length > 0) {
          const errorDetails = errored
            .map((r) => `${r.agent.agentType.name}: ${r.error}`)
            .join("\n");
          errorParts.push(`Invite errors:\n${errorDetails}`);
        }

        if (declined.length > 0) {
          const declineDetails = declined
            .map((r) => {
              const reason = r.response?.declineReason || "Unknown reason";
              const code = r.response?.declineCode ? ` (${r.response.declineCode})` : "";
              return `${r.agent.agentType.name}: ${reason}${code}`;
            })
            .join("\n");
          errorParts.push(`Declined:\n${declineDetails}`);
        }

        setStatus(errorParts.length > 0 ? errorParts.join("\n\n") : "All invites failed");
        setPhase("setup");
        return;
      }

      // Log partial failures but continue if at least one succeeded
      if (declined.length > 0 || errored.length > 0) {
        const failedNames = [...declined, ...errored]
          .map((r) => r.agent.agentType.name)
          .join(", ");
        console.warn(`[Chat] Some agents failed to join: ${failedNames}`);
      }

      // Connect to the work channel
      const client = connect<ChatParticipantMetadata>(pubsubConfig.serverUrl, pubsubConfig.token, {
        channel: newChannelId,
        reconnect: true,
        clientId,
        metadata: {
          name: "Chat Panel",
          type: "panel",
        },
      });

      clientRef.current = client;

      // Set up roster handler
      client.onRoster((roster: RosterUpdate<ChatParticipantMetadata>) => {
        setParticipants(roster.participants);
      });

      await client.ready();
      setConnected(true);
      setStatus("Connected");
      setPhase("chat");

      // Listen for messages
      void (async () => {
        for await (const msg of client.messages()) {
          handleMessage(msg);
        }
      })();
    } catch (err) {
      setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
      setPhase("setup");
    }
  }, [availableAgents, buildInviteConfig]);

  const addAgent = useCallback(async () => {
    const discovery = discoveryRef.current;
    if (!discovery || !channelId) return;

    // Find agents not currently in the chat
    const notInChat = availableAgents.filter(
      (a) => !Object.values(participants).some((p) => p.metadata.type === a.agentType.id)
    );

    if (notInChat.length === 0) {
      return;
    }

    // Invite first available agent not in chat
    const toInvite = notInChat[0];
    if (!toInvite) return;

    try {
      const filteredConfig = buildInviteConfig(toInvite);
      const result = discovery.invite(toInvite.broker.brokerId, toInvite.agentType.id, channelId, {
        context: "User invited additional agent to chat",
        config: filteredConfig,
      });
      await result.response;
    } catch (err) {
      console.error("Failed to invite agent:", err);
    }
  }, [availableAgents, channelId, participants, buildInviteConfig]);

  function handleMessage(msg: IncomingMessage) {
    switch (msg.type) {
      case "message": {
        setMessages((prev) => {
          const existingIndex = prev.findIndex((m) => m.id === msg.id && m.pending);
          if (existingIndex !== -1) {
            return prev.map((m, i) => (i === existingIndex ? { ...m, pending: false } : m));
          }
          return [
            ...prev,
            {
              id: msg.id,
              senderId: msg.senderId,
              content: msg.content,
              replyTo: msg.replyTo,
            },
          ];
        });
        break;
      }

      case "update-message": {
        setMessages((prev) =>
          prev.map((m) =>
            m.id === msg.id
              ? {
                  ...m,
                  content: msg.content !== undefined ? m.content + msg.content : m.content,
                  complete: msg.complete ?? m.complete,
                }
              : m
          )
        );
        break;
      }

      case "error": {
        setMessages((prev) => prev.map((m) => (m.id === msg.id ? { ...m, complete: true, error: msg.error } : m)));
        break;
      }
    }
  }

  const reset = useCallback(() => {
    setPhase("setup");
    setMessages([]);
    setInput("");
    setConnected(false);
    setStatus("Initializing...");
    setParticipants({});
    setChannelId(null);
    clientRef.current?.close();
    clientRef.current = null;
  }, []);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || !clientRef.current?.connected) return;

    const text = input.trim();
    setInput("");

    const messageId = await clientRef.current.send(text);

    setMessages((prev) => {
      if (prev.some((m) => m.id === messageId)) return prev;
      return [
        ...prev,
        {
          id: messageId,
          senderId: clientId,
          content: text,
          complete: true,
          pending: true,
        },
      ];
    });
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  // Compute participant counts
  const panelCount = Object.values(participants).filter((p) => p.metadata.type === "panel").length;
  const aiResponderCount = Object.values(participants).filter((p) => p.metadata.type === "ai-responder").length;
  const claudeCodeCount = Object.values(participants).filter((p) => p.metadata.type === "claude-code").length;
  const codexCount = Object.values(participants).filter((p) => p.metadata.type === "codex").length;

  const getSenderInfo = (senderId: string) => {
    const participant = participants[senderId];
    return participant?.metadata ?? { name: "Unknown", type: "panel" as const };
  };

  // Setup phase - show agent discovery and selection
  if (phase === "setup") {
    const selectedCount = availableAgents.filter((a) => a.selected).length;

    return (
      <Flex direction="column" style={{ height: "100vh", padding: 16 }} gap="3">
        <Flex justify="between" align="center">
          <Text size="5" weight="bold">
            Agentic Chat
          </Text>
          <Badge color="gray">{discoveryStatus}</Badge>
        </Flex>

        <Card style={{ flex: 1, overflow: "hidden" }}>
          <Flex direction="column" gap="3" p="3" style={{ height: "100%" }}>
            <Text size="3" weight="bold">
              Available Agents
            </Text>
            <Text size="2" color="gray">
              Select agents to invite to your chat session. Make sure Agent Manager is running.
            </Text>

            <ScrollArea style={{ flex: 1 }}>
              {availableAgents.length === 0 ? (
                <Flex direction="column" gap="2" align="center" justify="center" style={{ height: "100%" }}>
                  <Text size="2" color="gray">
                    No agents available.
                  </Text>
                  <Text size="1" color="gray">
                    Start the Agent Manager panel to advertise agents.
                  </Text>
                </Flex>
              ) : (
                <Flex direction="column" gap="2">
                  {availableAgents.map((agent) => (
                    <Card
                      key={`${agent.broker.brokerId}-${agent.agentType.id}`}
                      variant="surface"
                    >
                      <Flex direction="column" gap="2">
                        <Flex
                          gap="3"
                          align="start"
                          style={{ cursor: "pointer" }}
                          onClick={() => toggleAgentSelection(agent.broker.brokerId, agent.agentType.id)}
                        >
                          <Checkbox checked={agent.selected} />
                          <Flex direction="column" gap="1" style={{ flex: 1 }}>
                            <Text weight="medium">{agent.agentType.name}</Text>
                            <Text size="1" color="gray">
                              {agent.agentType.description}
                            </Text>
                            <Flex gap="1" wrap="wrap" mt="1">
                              {agent.agentType.tags?.map((tag) => (
                                <Badge key={tag} size="1" variant="outline">
                                  {tag}
                                </Badge>
                              ))}
                            </Flex>
                          </Flex>
                        </Flex>

                        {/* Parameter inputs - show when agent is selected and has parameters */}
                        {agent.selected && agent.agentType.parameters && agent.agentType.parameters.length > 0 && (
                          <Flex direction="column" gap="2" pl="6" pt="2" style={{ borderTop: "1px solid var(--gray-5)" }}>
                            {agent.agentType.parameters.map((param) => {
                              // Build placeholder text with default value info
                              const placeholderText = param.placeholder
                                ? param.default !== undefined
                                  ? `${param.placeholder} (default: ${param.default})`
                                  : param.placeholder
                                : param.default !== undefined
                                  ? `Default: ${param.default}`
                                  : undefined;

                              return (
                              <Flex key={param.key} direction="column" gap="1">
                                <Text size="1" weight="medium">
                                  {param.label}
                                  {param.required ? (
                                    <span style={{ color: "var(--red-9)" }}> *</span>
                                  ) : (
                                    <span style={{ color: "var(--gray-9)", fontWeight: "normal" }}> (optional)</span>
                                  )}
                                </Text>
                                {param.description && (
                                  <Text size="1" color="gray">
                                    {param.description}
                                  </Text>
                                )}
                                {param.type === "string" && (
                                  <TextField.Root
                                    size="1"
                                    placeholder={placeholderText}
                                    value={String(agent.config[param.key] ?? "")}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) =>
                                      updateAgentConfig(
                                        agent.broker.brokerId,
                                        agent.agentType.id,
                                        param.key,
                                        e.target.value
                                      )
                                    }
                                  />
                                )}
                                {param.type === "number" && (
                                  <TextField.Root
                                    size="1"
                                    type="number"
                                    placeholder={placeholderText}
                                    value={String(agent.config[param.key] ?? "")}
                                    onClick={(e) => e.stopPropagation()}
                                    onChange={(e) =>
                                      updateAgentConfig(
                                        agent.broker.brokerId,
                                        agent.agentType.id,
                                        param.key,
                                        e.target.value === "" ? "" : Number(e.target.value)
                                      )
                                    }
                                  />
                                )}
                                {param.type === "boolean" && (
                                  <Checkbox
                                    checked={Boolean(agent.config[param.key])}
                                    onClick={(e) => e.stopPropagation()}
                                    onCheckedChange={(checked) =>
                                      updateAgentConfig(
                                        agent.broker.brokerId,
                                        agent.agentType.id,
                                        param.key,
                                        Boolean(checked)
                                      )
                                    }
                                  />
                                )}
                                {param.type === "select" && param.options && (
                                  <Select.Root
                                    size="1"
                                    value={String(agent.config[param.key] ?? "")}
                                    onValueChange={(value) =>
                                      updateAgentConfig(
                                        agent.broker.brokerId,
                                        agent.agentType.id,
                                        param.key,
                                        value
                                      )
                                    }
                                  >
                                    <Select.Trigger
                                      placeholder="Select..."
                                      onClick={(e) => e.stopPropagation()}
                                    />
                                    <Select.Content>
                                      {param.options.map((option) => (
                                        <Select.Item key={option.value} value={option.value}>
                                          {option.label}
                                        </Select.Item>
                                      ))}
                                    </Select.Content>
                                  </Select.Root>
                                )}
                              </Flex>
                              );
                            })}
                          </Flex>
                        )}
                      </Flex>
                    </Card>
                  ))}
                </Flex>
              )}
            </ScrollArea>

            <Flex justify="between" align="center">
              <Text size="2" color="gray">
                {selectedCount} agent{selectedCount !== 1 ? "s" : ""} selected
              </Text>
              <Button onClick={() => void startChat()} disabled={selectedCount === 0}>
                Start Chat
              </Button>
            </Flex>
          </Flex>
        </Card>
      </Flex>
    );
  }

  // Connecting phase
  if (phase === "connecting") {
    return (
      <Flex direction="column" align="center" justify="center" style={{ height: "100vh", padding: 16 }} gap="3">
        <Text size="4">{status}</Text>
      </Flex>
    );
  }

  // Chat phase
  return (
    <Flex direction="column" style={{ height: "100vh", padding: 16 }} gap="3">
      {/* Header */}
      <Flex justify="between" align="center">
        <Flex gap="2" align="center">
          <Text size="5" weight="bold">
            Agentic Chat
          </Text>
          <Badge color="gray">{channelId}</Badge>
        </Flex>
        <Flex gap="2" align="center">
          <Badge color={connected ? "green" : "gray"}>{connected ? "Connected" : status}</Badge>
          {panelCount > 0 && (
            <Badge color="blue">
              {panelCount} Panel{panelCount !== 1 ? "s" : ""}
            </Badge>
          )}
          {aiResponderCount > 0 && (
            <Badge color="purple">
              {aiResponderCount} AI Responder{aiResponderCount !== 1 ? "s" : ""}
            </Badge>
          )}
          {claudeCodeCount > 0 && <Badge color="orange">{claudeCodeCount} Claude Code</Badge>}
          {codexCount > 0 && <Badge color="teal">{codexCount} Codex</Badge>}
          <Button variant="soft" size="1" onClick={() => void addAgent()}>
            Add Agent
          </Button>
          <Button variant="soft" onClick={reset}>
            Reset
          </Button>
        </Flex>
      </Flex>

      {/* Messages */}
      <Card style={{ flex: 1, overflow: "hidden" }}>
        <ScrollArea style={{ height: "100%" }}>
          <Flex direction="column" gap="2" p="3">
            {messages.length === 0 ? (
              <Text color="gray" size="2">
                Send a message to start chatting
              </Text>
            ) : (
              messages.map((msg) => {
                const sender = getSenderInfo(msg.senderId);
                const isPanel = sender.type === "panel";
                const isStreaming = !msg.complete && !msg.error;
                return (
                  <Box
                    key={msg.id}
                    style={{
                      alignSelf: isPanel ? "flex-end" : "flex-start",
                      maxWidth: "80%",
                    }}
                  >
                    <Card
                      style={{
                        backgroundColor: isPanel
                          ? "var(--accent-9)"
                          : msg.error
                            ? "var(--red-3)"
                            : "var(--gray-3)",
                        opacity: msg.pending ? 0.7 : 1,
                      }}
                    >
                      <Text
                        size="2"
                        style={{
                          color: isPanel ? "white" : msg.error ? "var(--red-11)" : "inherit",
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {msg.error ? `Error: ${msg.error}` : msg.content || (isStreaming ? "..." : "")}
                        {isStreaming && <span className="cursor">|</span>}
                      </Text>
                    </Card>
                  </Box>
                );
              })
            )}
            <div ref={scrollRef} />
          </Flex>
        </ScrollArea>
      </Card>

      {/* Input */}
      <Flex gap="2">
        <TextField.Root
          style={{ flex: 1 }}
          placeholder="Type a message..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!connected}
        />
        <Button onClick={() => void sendMessage()} disabled={!connected || !input.trim()}>
          Send
        </Button>
      </Flex>
    </Flex>
  );
}
