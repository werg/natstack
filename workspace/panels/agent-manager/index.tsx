/**
 * Agent Preferences Panel
 *
 * Configure default settings for AI agents. Also serves as a broker
 * that spawns workers when clients invite agents.
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
  Separator,
  Tabs,
} from "@radix-ui/themes";
import { ChevronDownIcon, ChevronRightIcon } from "@radix-ui/react-icons";
import { createChild, pubsubConfig, db, type ChildHandle } from "@natstack/runtime";
import { usePanelTheme, ParameterEditor } from "@natstack/react";
import {
  connectAsBroker,
  type BrokerClient,
  type AgentTypeAdvertisement,
  type Invite,
} from "@natstack/agentic-messaging/broker";
import {
  CLAUDE_CODE_PARAMETERS,
  AI_RESPONDER_PARAMETERS,
  CODEX_PARAMETERS,
} from "@natstack/agentic-messaging/config";

const AVAILABILITY_CHANNEL = "agent-availability";
const PREFERENCES_DB_NAME = "agent-preferences";

/** Persisted defaults structure - keyed by agent type ID */
type AgentDefaults = Record<string, Record<string, string | number | boolean>>;

/** Preferences database singleton */
let preferencesDbPromise: Promise<Awaited<ReturnType<typeof db.open>>> | null = null;

async function getPreferencesDb() {
  if (!preferencesDbPromise) {
    preferencesDbPromise = (async () => {
      const database = await db.open(PREFERENCES_DB_NAME);
      await database.exec(`
        CREATE TABLE IF NOT EXISTS agent_preferences (
          agent_type_id TEXT PRIMARY KEY,
          settings TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      return database;
    })();
  }
  return preferencesDbPromise;
}

/** Load all agent defaults from SQLite */
async function loadAgentDefaults(): Promise<AgentDefaults> {
  try {
    const database = await getPreferencesDb();
    const rows = await database.query<{ agent_type_id: string; settings: string }>(
      "SELECT agent_type_id, settings FROM agent_preferences"
    );
    const result: AgentDefaults = {};
    for (const row of rows) {
      try {
        result[row.agent_type_id] = JSON.parse(row.settings);
      } catch {
        // Skip malformed entries
      }
    }
    return result;
  } catch (err) {
    console.warn("[AgentPreferences] Failed to load defaults:", err);
    return {};
  }
}

/** Save defaults for a specific agent type to SQLite */
async function saveAgentDefaults(
  agentTypeId: string,
  settings: Record<string, string | number | boolean>
): Promise<void> {
  try {
    const database = await getPreferencesDb();
    const settingsJson = JSON.stringify(settings);
    const now = Date.now();
    await database.run(
      `INSERT INTO agent_preferences (agent_type_id, settings, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(agent_type_id) DO UPDATE SET settings = ?, updated_at = ?`,
      [agentTypeId, settingsJson, now, settingsJson, now]
    );
  } catch (err) {
    console.warn("[AgentPreferences] Failed to save defaults:", err);
  }
}


/** Agent type definitions - using centralized parameter configs */
const AGENT_TYPES: AgentTypeAdvertisement[] = [
  {
    id: "ai-responder",
    name: "AI Responder",
    proposedHandle: "ai",
    description: "AI assistant using NatStack AI SDK with agentic tool support.",
    providesMethods: [],
    requiresMethods: [
      { name: "feedback_form", description: "Display forms for tool approval", required: true },
    ],
    parameters: AI_RESPONDER_PARAMETERS,
    tags: ["chat", "ai", "agentic", "tools"],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    proposedHandle: "claude",
    description: "Claude-based coding agent with tool access for complex development tasks.",
    providesMethods: [],
    requiresMethods: [
      // UI feedback methods
      { name: "feedback_form", description: "Display schema-based forms for user input", required: true },
      { name: "feedback_custom", description: "Display custom TSX UI for complex interactions", required: true },
      // File operations (for restricted environments)
      { name: "file_read", description: "Read file contents", required: false },
      { name: "file_write", description: "Write file contents", required: false },
      { name: "file_edit", description: "Edit file with string replacement", required: false },
      { name: "rm", description: "Delete files or directories", required: false },
      // Search tools
      { name: "glob", description: "Find files by glob pattern", required: false },
      { name: "grep", description: "Search file contents", required: false },
      // Directory tools
      { name: "tree", description: "Show directory tree", required: false },
      { name: "list_directory", description: "List directory contents", required: false },
      // Git tools (essential when no bash)
      { name: "git_status", description: "Git repository status", required: false },
      { name: "git_diff", description: "Show file changes", required: false },
      { name: "git_log", description: "Commit history", required: false },
      { name: "git_add", description: "Stage files", required: false },
      { name: "git_commit", description: "Create commits", required: false },
      { name: "git_checkout", description: "Switch branches or restore files", required: false },
    ],
    parameters: CLAUDE_CODE_PARAMETERS,
    tags: ["chat", "coding", "tools", "claude"],
  },
  {
    id: "codex",
    name: "Codex",
    proposedHandle: "codex",
    description: "OpenAI Codex agent specialized for code tasks with MCP tool support.",
    providesMethods: [],
    requiresMethods: [],
    parameters: CODEX_PARAMETERS,
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
  config?: Record<string, unknown>;
}

/** Active agent tracking */
interface ActiveAgent {
  id: string;
  agentTypeId: string;
  channel: string;
  handle: ChildHandle;
  startedAt: Date;
  config?: Record<string, unknown>;
}

/** Collapsible section component */
function CollapsibleSection({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Flex direction="column" gap="2">
      <Flex
        align="center"
        gap="2"
        style={{ cursor: "pointer", userSelect: "none" }}
        onClick={() => setOpen(!open)}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <Text size="2" color="gray" weight="medium">
          {title}
          {count !== undefined && ` (${count})`}
        </Text>
      </Flex>
      {open && children}
    </Flex>
  );
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

export default function AgentPreferences() {
  const theme = usePanelTheme();
  const [connected, setConnected] = useState(false);
  const [status, setStatus] = useState("Initializing...");
  const [activeAgents, setActiveAgents] = useState<ActiveAgent[]>([]);
  const [inviteLog, setInviteLog] = useState<InviteLogEntry[]>([]);
  const [agentDefaults, setAgentDefaults] = useState<AgentDefaults>({});

  const brokerRef = useRef<BrokerClient | null>(null);
  const activeAgentsRef = useRef<ActiveAgent[]>([]);

  // Load defaults from SQLite on mount
  useEffect(() => {
    void loadAgentDefaults().then(setAgentDefaults);
  }, []);

  // Update a default value for an agent type
  const updateDefault = useCallback((agentTypeId: string, key: string, value: string | number | boolean) => {
    setAgentDefaults((prev) => {
      const updated = {
        ...prev,
        [agentTypeId]: {
          ...(prev[agentTypeId] ?? {}),
          [key]: value,
        },
      };
      void saveAgentDefaults(agentTypeId, updated[agentTypeId]);
      return updated;
    });
  }, []);

  const addLogEntry = useCallback((entry: Omit<InviteLogEntry, "id" | "timestamp">) => {
    setInviteLog((prev) => [
      {
        ...entry,
        id: crypto.randomUUID(),
        timestamp: new Date(),
      },
      ...prev.slice(0, 49),
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
      setStatus("Connecting...");

      try {
        const broker = await connectAsBroker(pubsubConfig!.serverUrl, pubsubConfig!.token, {
          availabilityChannel: AVAILABILITY_CHANNEL,
          name: "Agent Preferences",
          handle: "agent-preferences",
          agentTypes: AGENT_TYPES,
          onInvite: async (invite: Invite, senderId: string) => {
            console.log(`[AgentPreferences] Received invite from ${senderId} for ${invite.agentTypeId}`);
            return { accept: true };
          },
          onSpawn: async (invite: Invite, agentType: AgentTypeAdvertisement) => {
            console.log(`[AgentPreferences] Spawning ${agentType.id} for channel ${invite.targetChannel}`);

            try {
              const workerSource = getWorkerSource(agentType.id);
              const workerName = `${agentType.id}-${invite.targetChannel.slice(0, 8)}`;
              const agentHandle = invite.handleOverride ?? agentType.proposedHandle;

              const agentConfig = {
                ...invite.config,
                handle: agentHandle,
                agentTypeId: agentType.id, // Pass agent type for recovery identification
              };
              const env: Record<string, string> = {
                CHANNEL: invite.targetChannel,
                AGENT_CONFIG: JSON.stringify(agentConfig),
              };

              const handle = await createChild(workerSource, { name: workerName, env });

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
                  senderId: invite.inviteId,
                  accepted: true,
                  config: invite.config,
                });
              }

              return { agentId: handle.id };
            } catch (err) {
              const errorMsg = err instanceof Error ? err.message : String(err);
              console.error(`[AgentPreferences] Failed to spawn agent:`, err);

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
      p="3"
      style={{
        height: "100vh",
        backgroundColor: theme === "dark" ? "var(--gray-1)" : "var(--gray-2)",
      }}
    >
      <Flex direction="column" gap="3" style={{ height: "100%" }}>
        {/* Header */}
        <Flex justify="between" align="center">
          <Heading size="4">Agent Preferences</Heading>
          <Badge size="1" color={connected ? "green" : "gray"} variant="soft">
            {connected ? "Ready" : status}
          </Badge>
        </Flex>

        {/* Tabbed Content */}
        <Tabs.Root defaultValue="preferences" style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          <Tabs.List size="2">
            <Tabs.Trigger value="preferences">Preferences</Tabs.Trigger>
            <Tabs.Trigger value="agents">
              Active Agents
              {activeAgents.length > 0 && (
                <Badge size="1" ml="2" color="green">{activeAgents.length}</Badge>
              )}
            </Tabs.Trigger>
          </Tabs.List>

          <Box pt="3" style={{ flex: 1, overflow: "hidden" }}>
            {/* Preferences Tab */}
            <Tabs.Content value="preferences" style={{ height: "100%" }}>
              <ScrollArea style={{ height: "100%" }}>
                <Flex direction="column" gap="4" pr="3">
                  {AGENT_TYPES.map((agentType) => (
                    <Card key={agentType.id}>
                      <Flex direction="column" gap="3">
                        {/* Agent header */}
                        <Flex justify="between" align="center">
                          <Text size="4" weight="bold">{agentType.name}</Text>
                        </Flex>
                        <Text size="2" color="gray">{agentType.description}</Text>

                        {/* Parameters - always visible */}
                        {agentType.parameters && agentType.parameters.length > 0 && (
                          <>
                            <Separator size="4" />
                            <ParameterEditor
                              parameters={agentType.parameters}
                              values={agentDefaults[agentType.id] ?? {}}
                              onChange={(key: string, value: string | number | boolean) => updateDefault(agentType.id, key, value)}
                            />
                          </>
                        )}
                      </Flex>
                    </Card>
                  ))}
                </Flex>
              </ScrollArea>
            </Tabs.Content>

            {/* Active Agents Tab */}
            <Tabs.Content value="agents" style={{ height: "100%" }}>
              <ScrollArea style={{ height: "100%" }}>
                <Flex direction="column" gap="4" pr="3">
                  {/* Running Agents */}
                  <Flex direction="column" gap="3">
                    <Text size="2" weight="medium" color="gray">
                      Running Agents
                    </Text>
                    {activeAgents.length === 0 ? (
                      <Card variant="surface">
                        <Text size="2" color="gray">
                          No active agents. Start a chat in the Agentic Chat panel to spawn agents.
                        </Text>
                      </Card>
                    ) : (
                      activeAgents.map((agent) => (
                        <Card key={agent.id} variant="surface">
                          <Flex justify="between" align="center">
                            <Flex direction="column" gap="1">
                              <Text size="2" weight="medium">
                                {AGENT_TYPES.find((t) => t.id === agent.agentTypeId)?.name || agent.agentTypeId}
                              </Text>
                              <Text size="1" color="gray">
                                Started {agent.startedAt.toLocaleTimeString()}
                              </Text>
                            </Flex>
                            <Flex gap="2" align="center">
                              <Badge color="green" variant="soft" size="1">Running</Badge>
                              <Button size="1" variant="soft" color="red" onClick={() => stopAgent(agent.id)}>
                                Stop
                              </Button>
                            </Flex>
                          </Flex>
                        </Card>
                      ))
                    )}
                  </Flex>

                  {/* Invite History - Collapsible */}
                  <CollapsibleSection title="Invite History" count={inviteLog.length}>
                    <Flex direction="column" gap="2">
                      {inviteLog.length === 0 ? (
                        <Text size="1" color="gray">No invites yet.</Text>
                      ) : (
                        inviteLog.map((entry) => (
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
                                    {entry.accepted ? "OK" : "Failed"}
                                  </Badge>
                                  <Text size="1" weight="medium">
                                    {AGENT_TYPES.find((t) => t.id === entry.agentTypeId)?.name || entry.agentTypeId}
                                  </Text>
                                </Flex>
                                <Text size="1" color="gray">
                                  {entry.timestamp.toLocaleTimeString()}
                                </Text>
                              </Flex>
                              {entry.error && (
                                <Text size="1" color="red">Error: {entry.error}</Text>
                              )}
                              <JsonInspector data={entry.config} label="Config" />
                            </Flex>
                          </Card>
                        ))
                      )}
                    </Flex>
                  </CollapsibleSection>
                </Flex>
              </ScrollArea>
            </Tabs.Content>
          </Box>
        </Tabs.Root>
      </Flex>
    </Box>
  );
}
