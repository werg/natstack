/**
 * PubSub Chat Demo Panel
 *
 * Demonstrates @natstack/pubsub for real-time messaging between a panel and worker.
 * Messages flow through the PubSub WebSocket server, not via direct RPC.
 */

import { useState, useEffect, useRef, useCallback } from "react";
import { Button, Card, Flex, Text, TextField, ScrollArea, Box, Badge } from "@radix-ui/themes";
import { createChild, pubsubConfig, id as clientId, type ChildHandle } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import { connect, type PubSubClient, type Message, type RosterUpdate, type Participant } from "@natstack/pubsub";

/**
 * Chat message as stored locally.
 */
interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  replyTo?: string;
  error?: string;
  /** True if locally added but not yet confirmed via broadcast */
  pending?: boolean;
}

/**
 * Wire format: "message" - creates a new message
 */
interface NewMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  streaming?: boolean;
  replyTo?: string;
}

/**
 * Wire format: "update-message" - updates an existing message
 */
interface UpdateMessage {
  id: string;
  /** Content to append to existing message */
  content?: string;
  /** Set to false to mark streaming complete */
  streaming?: boolean;
}

/**
 * Wire format: "error" - marks a message as errored
 */
interface ErrorMessage {
  id: string;
  error: string;
}

/** Metadata for participants in this channel */
interface ChatParticipantMetadata {
  name: string;
  role: "panel" | "worker";
}

const CHANNEL_NAME = "pubsub-chat-demo";

export default function PubSubChatDemo() {
  const theme = usePanelTheme();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [connected, setConnected] = useState(false);
  const [worker, setWorker] = useState<ChildHandle | null>(null);
  const [status, setStatus] = useState("Initializing...");
  const [participants, setParticipants] = useState<Record<string, Participant<ChatParticipantMetadata>>>({});

  const clientRef = useRef<PubSubClient<ChatParticipantMetadata> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom when messages change
  useEffect(() => {
    scrollRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Initialize worker and pubsub connection
  useEffect(() => {
    let mounted = true;
    let client: PubSubClient<ChatParticipantMetadata> | null = null;

    async function init() {
      if (!pubsubConfig) {
        setStatus("Error: PubSub not available");
        return;
      }

      try {
        // 1. Launch the AI responder worker
        setStatus("Launching AI worker...");
        const w = await createChild({
          type: "worker",
          name: "chat-responder",
          source: "workers/pubsub-chat-responder",
        });
        if (!mounted) return;
        setWorker(w);

        // 2. Connect to the pubsub channel with participant metadata
        setStatus("Connecting to channel...");
        client = connect<ChatParticipantMetadata>(pubsubConfig.serverUrl, pubsubConfig.token, {
          channel: CHANNEL_NAME,
          reconnect: true,
          clientId, // For echo suppression
          metadata: {
            name: "Chat Panel",
            role: "panel",
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

        // 4. Listen for messages
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

    function handleMessage(msg: Message) {
      switch (msg.type) {
        case "message": {
          const payload = msg.payload as NewMessage;
          setMessages(prev => {
            // Check if we already have this message as pending (our own optimistic add)
            const existingIndex = prev.findIndex(m => m.id === payload.id && m.pending);
            if (existingIndex !== -1) {
              // Convert pending → sent
              return prev.map((m, i) => i === existingIndex ? { ...m, pending: false } : m);
            }
            // New message from another client
            return [...prev, {
              id: payload.id,
              role: payload.role,
              content: payload.content,
              streaming: payload.streaming,
              replyTo: payload.replyTo,
            }];
          });
          break;
        }

        case "update-message": {
          const payload = msg.payload as UpdateMessage;
          setMessages(prev => prev.map(m =>
            m.id === payload.id
              ? {
                  ...m,
                  content: payload.content !== undefined ? m.content + payload.content : m.content,
                  streaming: payload.streaming ?? m.streaming,
                }
              : m
          ));
          break;
        }

        case "error": {
          const payload = msg.payload as ErrorMessage;
          setMessages(prev => prev.map(m =>
            m.id === payload.id
              ? { ...m, streaming: false, error: payload.error }
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
      worker?.close();
    };
  }, []);

  const sendMessage = useCallback(async () => {
    if (!input.trim() || !clientRef.current?.connected) return;

    const messageId = crypto.randomUUID();
    const text = input.trim();
    setInput("");

    const chatMsg: ChatMessage = {
      id: messageId,
      role: "user",
      content: text,
      pending: true, // Optimistic - will be confirmed when broadcast arrives
    };

    // Add to local UI immediately (pending state)
    setMessages(prev => [...prev, chatMsg]);

    // Publish to channel (persisted) - we'll receive the broadcast back which converts pending→sent
    await clientRef.current.publish("message", {
      id: messageId,
      role: "user",
      content: text,
    } satisfies NewMessage);
  }, [input]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  // Compute participant counts
  const panelCount = Object.values(participants).filter(p => p.metadata.role === "panel").length;
  const workerCount = Object.values(participants).filter(p => p.metadata.role === "worker").length;

  return (
    <Flex direction="column" style={{ height: "100vh", padding: 16 }} gap="3">
      {/* Header */}
      <Flex justify="between" align="center">
        <Text size="5" weight="bold">PubSub Chat Demo</Text>
        <Flex gap="2" align="center">
          <Badge color={connected ? "green" : "gray"}>
            {connected ? "Connected" : status}
          </Badge>
          {panelCount > 0 && (
            <Badge color="blue" title={Object.values(participants).filter(p => p.metadata.role === "panel").map(p => p.metadata.name).join(", ")}>
              {panelCount} Panel{panelCount !== 1 ? "s" : ""}
            </Badge>
          )}
          {workerCount > 0 && (
            <Badge color="purple" title={Object.values(participants).filter(p => p.metadata.role === "worker").map(p => p.metadata.name).join(", ")}>
              {workerCount} Worker{workerCount !== 1 ? "s" : ""}
            </Badge>
          )}
        </Flex>
      </Flex>

      {/* Messages */}
      <Card style={{ flex: 1, overflow: "hidden" }}>
        <ScrollArea style={{ height: "100%" }}>
          <Flex direction="column" gap="2" p="3">
            {messages.length === 0 ? (
              <Text color="gray" size="2">
                Send a message to start chatting with the AI worker via PubSub
              </Text>
            ) : (
              messages.map(msg => (
                <Box
                  key={msg.id}
                  style={{
                    alignSelf: msg.role === "user" ? "flex-end" : "flex-start",
                    maxWidth: "80%",
                  }}
                >
                  <Card
                    style={{
                      backgroundColor: msg.role === "user"
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
                        color: msg.role === "user" ? "white" : msg.error ? "var(--red-11)" : "inherit",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {msg.error ? `Error: ${msg.error}` : msg.content || (msg.streaming ? "..." : "")}
                      {msg.streaming && !msg.error && <span className="cursor">|</span>}
                    </Text>
                  </Card>
                </Box>
              ))
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
