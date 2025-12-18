/**
 * Agentic Messaging Chat Demo Panel
 *
 * Demonstrates @natstack/agentic-messaging for real-time messaging between a panel and worker.
 * Messages flow through the PubSub WebSocket server with protocol validation.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { Button, Card, Flex, Text, TextField, ScrollArea, Box, Badge } from "@radix-ui/themes";
import { createChild, pubsubConfig, id as clientId, type ChildHandle } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import {
  connect,
  type AgenticClient,
  type AgenticParticipantMetadata,
  type IncomingMessage,
  type Participant,
  type RosterUpdate,
} from "@natstack/agentic-messaging";

/**
 * Chat message as stored locally.
 */
interface ChatMessage {
  id: string;
  /** Client ID of the sender - used to look up participant metadata */
  senderId: string;
  content: string;
  /** True when the message is complete (no more updates expected) */
  complete?: boolean;
  replyTo?: string;
  error?: string;
  /** True if locally added but not yet confirmed via broadcast */
  pending?: boolean;
}

/** Metadata for participants in this channel */
interface ChatParticipantMetadata extends AgenticParticipantMetadata {
  name: string;
  type: "panel" | "worker" | "claude-code" | "codex";
}

type ResponderType = "worker" | "claude-code" | "codex";
type AppPhase = "setup" | "chat";

export default function AgenticChatDemo() {
  const theme = usePanelTheme();
  const [phase, setPhase] = useState<AppPhase>("setup");
  const [channelName, setChannelName] = useState("agentic-chat-demo");
  const [responderType, setResponderType] = useState<ResponderType>("worker");

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [responder, setResponder] = useState<ChildHandle | null>(null);
  const [status, setStatus] = useState("Initializing...");
  const [participants, setParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});

  const clientRef = useRef<AgenticClient<ChatParticipantMetadata> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const reset = useCallback(() => {
    setPhase("setup");
    setMessages([]);
    setInput("");
    setConnected(false);
    setStatus("Initializing...");
    setParticipants({});
    clientRef.current?.close();
    clientRef.current = null;
    void responder?.close();
    setResponder(null);
  }, [responder]);

  // Initialize responder and agentic messaging connection
  useEffect(() => {
    if (phase !== "chat") {
      return;
    }

    let mounted = true;
    let client: AgenticClient<ChatParticipantMetadata> | null = null;
    let createdResponder: ChildHandle | null = null;

    async function init() {
      if (!pubsubConfig) {
        setStatus("Error: PubSub not available");
        return;
      }

      try {
        // 1. Launch responder worker based on type
        setStatus(`Launching ${responderType} responder...`);
        const workerSource = responderType === "worker"
          ? "workers/pubsub-chat-responder"
          : responderType === "claude-code"
            ? "workers/claude-code-responder"
            : "workers/codex-responder";

        createdResponder = await createChild({
          type: "worker",
          name: `${responderType}-responder`,
          source: workerSource,
          // Note: unsafe mode is controlled by the worker's manifest, not here
          // This allows each worker to specify its own fs root (e.g., "/" for full access)
        });

        if (!mounted) return;
        setResponder(createdResponder);

        // 2. Connect to the agentic messaging channel
        setStatus("Connecting to channel...");
        client = connect<ChatParticipantMetadata>(pubsubConfig.serverUrl, pubsubConfig.token, {
          channel: channelName,
          reconnect: true,
          clientId, // For echo suppression
          metadata: {
            name: "Chat Panel",
            type: "panel",
          },
        });
        clientRef.current = client;

        // 3. Set up roster handler to track online participants
        client.onRoster((roster: RosterUpdate<ChatParticipantMetadata>) => {
          if (mounted) {
            setParticipants(roster.participants);
          }
        });

        await client.ready();
        if (!mounted) return;

        setConnected(true);
        setStatus("Connected");

        // 4. Listen for messages using the typed API
        for await (const msg of client.messages()) {
          if (!mounted) break;
          handleMessage(msg);
        }
      } catch (error) {
        if (mounted) {
          setStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    function handleMessage(msg: IncomingMessage) {
      switch (msg.type) {
        case "message": {
          setMessages(prev => {
            // Check if we already have this message as pending (our own optimistic add)
            const existingIndex = prev.findIndex(m => m.id === msg.id && m.pending);
            if (existingIndex !== -1) {
              // Convert pending → sent
              return prev.map((m, i) => i === existingIndex ? { ...m, pending: false } : m);
            }
            // New message from another client
            return [...prev, {
              id: msg.id,
              senderId: msg.senderId,
              content: msg.content,
              replyTo: msg.replyTo,
            }];
          });
          break;
        }

        case "update-message": {
          setMessages(prev => prev.map(m =>
            m.id === msg.id
              ? {
                  ...m,
                  content: msg.content !== undefined ? m.content + msg.content : m.content,
                  complete: msg.complete ?? m.complete,
                }
              : m
          ));
          break;
        }

        case "error": {
          setMessages(prev => prev.map(m =>
            m.id === msg.id
              ? { ...m, complete: true, error: msg.error }
              : m
          ));
          break;
        }
      }
    }

    init();

    return () => {
      mounted = false;
      client?.close();
      void createdResponder?.close();
    };
  }, [channelName, phase, responderType]);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || !clientRef.current?.connected) return;

    const text = input.trim();
    setInput("");

    // Use the agentic messaging send() API - it generates the ID for us
    const messageId = await clientRef.current.send(text);

    // We'll receive the broadcast back which adds it to the list
    // But add optimistically for instant feedback
    setMessages(prev => {
      // Only add if not already present (from broadcast)
      if (prev.some(m => m.id === messageId)) return prev;
      return [...prev, {
        id: messageId,
        senderId: clientId,
        content: text,
        complete: true,
        pending: true,
      }];
    });
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  // Compute participant counts
  const panelCount = Object.values(participants).filter(p => p.metadata.type === "panel").length;
  const workerCount = Object.values(participants).filter(p => p.metadata.type === "worker").length;
  const claudeCodeCount = Object.values(participants).filter(p => p.metadata.type === "claude-code").length;
  const codexCount = Object.values(participants).filter(p => p.metadata.type === "codex").length;

  // Helper to get sender info from participants roster
  const getSenderInfo = (senderId: string) => {
    const participant = participants[senderId];
    return participant?.metadata ?? { name: "Unknown", type: "panel" as const };
  };

  if (phase === "setup") {
    return (
      <Flex direction="column" style={{ height: "100vh", padding: 16 }} gap="3">
        <Flex justify="between" align="center">
          <Text size="5" weight="bold">Agentic Chat Demo</Text>
          <Badge color="gray">Setup</Badge>
        </Flex>

        <Card>
          <Flex direction="column" gap="3" p="3">
            <Text size="3" weight="bold">Responder</Text>
            <Flex gap="2" wrap="wrap">
              <Button
                variant={responderType === "worker" ? "solid" : "soft"}
                onClick={() => setResponderType("worker")}
              >
                Worker (AI SDK)
              </Button>
              <Button
                variant={responderType === "claude-code" ? "solid" : "soft"}
                onClick={() => setResponderType("claude-code")}
              >
                Claude Code
              </Button>
              <Button
                variant={responderType === "codex" ? "solid" : "soft"}
                onClick={() => setResponderType("codex")}
              >
                Codex (GPT-4o)
              </Button>
            </Flex>

            <Text size="2" weight="bold">Channel</Text>
            <TextField.Root
              placeholder="Channel name"
              value={channelName}
              onChange={(e) => setChannelName(e.target.value)}
            />

            <Text size="1" color="gray">
              {responderType === "worker"
                ? "Worker responder uses the NatStack AI SDK to reply to panel messages."
                : responderType === "claude-code"
                  ? "Claude Code responder uses the Claude Code SDK (unsafe worker)."
                  : "Codex responder uses the OpenAI SDK with GPT-4o (unsafe worker)."
              }
            </Text>

            <Flex justify="between" align="center" mt="2">
              <Text size="2" color="gray">
                {pubsubConfig ? "Ready" : "PubSub not available"}
              </Text>
              <Button
                onClick={() => {
                  setMessages([]);
                  setParticipants({});
                  setStatus("Initializing...");
                  setPhase("chat");
                }}
                disabled={!pubsubConfig || !channelName.trim()}
              >
                Start
              </Button>
            </Flex>
          </Flex>
        </Card>
      </Flex>
    );
  }

  return (
    <Flex direction="column" style={{ height: "100vh", padding: 16 }} gap="3">
      {/* Header */}
      <Flex justify="between" align="center">
        <Flex gap="2" align="center">
          <Text size="5" weight="bold">Agentic Chat Demo</Text>
          <Badge color="gray">{channelName}</Badge>
        </Flex>
        <Flex gap="2" align="center">
          <Badge color={connected ? "green" : "gray"}>
            {connected ? "Connected" : status}
          </Badge>
          {panelCount > 0 && (
            <Badge color="blue" title={Object.values(participants).filter(p => p.metadata.type === "panel").map(p => p.metadata.name).join(", ")}>
              {panelCount} Panel{panelCount !== 1 ? "s" : ""}
            </Badge>
          )}
          {workerCount > 0 && (
            <Badge color="purple" title={Object.values(participants).filter(p => p.metadata.type === "worker").map(p => p.metadata.name).join(", ")}>
              {workerCount} Worker{workerCount !== 1 ? "s" : ""}
            </Badge>
          )}
          {claudeCodeCount > 0 && (
            <Badge color="orange" title={Object.values(participants).filter(p => p.metadata.type === "claude-code").map(p => p.metadata.name).join(", ")}>
              {claudeCodeCount} Claude Code
            </Badge>
          )}
          {codexCount > 0 && (
            <Badge color="teal" title={Object.values(participants).filter(p => p.metadata.type === "codex").map(p => p.metadata.name).join(", ")}>
              {codexCount} Codex
            </Badge>
          )}
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
              messages.map(msg => {
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
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!connected}
        />
        <Button
          onClick={() => void sendMessage()}
          disabled={!connected || !input.trim()}
        >
          Send
        </Button>
      </Flex>
    </Flex>
  );
}
