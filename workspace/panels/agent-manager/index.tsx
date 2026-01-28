/**
 * Agent Manager Panel
 *
 * CRUD UI for managing agent definitions in the SQLite registry.
 * Seeds built-in agents on first run.
 */

import { useState, useEffect, useCallback } from "react";
import {
  Box,
  Card,
  Flex,
  Text,
  Heading,
  Badge,
  Button,
  ScrollArea,
  Switch,
  Separator,
} from "@radix-ui/themes";
import { usePanelTheme, ParameterEditor } from "@natstack/react";
import { db, type FieldValue } from "@natstack/runtime";
import {
  getAgentRegistry,
  type AgentDefinition,
} from "@natstack/agentic-messaging/registry";
import {
  CLAUDE_CODE_PARAMETERS,
  AI_RESPONDER_PARAMETERS,
  CODEX_PARAMETERS,
} from "@natstack/agentic-messaging/config";

const PREFERENCES_DB_NAME = "agent-preferences";

/** Persisted defaults structure - keyed by agent type ID */
type AgentDefaults = Record<string, Record<string, FieldValue>>;

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
    console.warn("[AgentManager] Failed to load defaults:", err);
    return {};
  }
}

/** Save defaults for a specific agent type to SQLite */
async function saveAgentDefaults(
  agentTypeId: string,
  settings: Record<string, FieldValue>
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
    console.warn("[AgentManager] Failed to save defaults:", err);
  }
}

/** Built-in agent definitions to seed on first run */
const BUILT_IN_AGENTS: Omit<AgentDefinition, "createdAt" | "updatedAt">[] = [
  {
    id: "ai-responder",
    name: "AI Responder",
    workerSource: "workers/pubsub-chat-responder",
    proposedHandle: "ai",
    description: "AI assistant using NatStack AI SDK with agentic tool support.",
    parameters: AI_RESPONDER_PARAMETERS,
    providesMethods: [],
    requiresMethods: [{ name: "feedback_form", required: true }],
    tags: ["chat", "ai", "agentic", "tools"],
    enabled: true,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    workerSource: "workers/claude-code-responder",
    proposedHandle: "claude",
    description: "Claude-based coding agent with tool access for complex development tasks.",
    parameters: CLAUDE_CODE_PARAMETERS,
    providesMethods: [],
    requiresMethods: [
      { name: "feedback_form", description: "Display schema-based forms for user input", required: true },
      { name: "feedback_custom", description: "Display custom TSX UI for complex interactions", required: true },
      { name: "file_read", description: "Read file contents", required: false },
      { name: "file_write", description: "Write file contents", required: false },
      { name: "file_edit", description: "Edit file with string replacement", required: false },
      { name: "rm", description: "Delete files or directories", required: false },
      { name: "glob", description: "Find files by glob pattern", required: false },
      { name: "grep", description: "Search file contents", required: false },
      { name: "tree", description: "Show directory tree", required: false },
      { name: "list_directory", description: "List directory contents", required: false },
      { name: "git_status", description: "Git repository status", required: false },
      { name: "git_diff", description: "Show file changes", required: false },
      { name: "git_log", description: "Commit history", required: false },
      { name: "git_add", description: "Stage files", required: false },
      { name: "git_commit", description: "Create commits", required: false },
      { name: "git_checkout", description: "Switch branches or restore files", required: false },
    ],
    tags: ["chat", "coding", "tools", "claude"],
    enabled: true,
  },
  {
    id: "codex",
    name: "Codex",
    workerSource: "workers/codex-responder",
    proposedHandle: "codex",
    description: "OpenAI Codex agent specialized for code tasks with MCP tool support.",
    parameters: CODEX_PARAMETERS,
    providesMethods: [],
    requiresMethods: [],
    tags: ["chat", "coding", "tools", "openai"],
    enabled: true,
  },
];

export default function AgentManager() {
  const theme = usePanelTheme();
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [agentDefaults, setAgentDefaults] = useState<AgentDefaults>({});
  const [status, setStatus] = useState("Loading...");
  const [isLoading, setIsLoading] = useState(true);

  // Load agents from registry and seed if empty
  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        const registry = getAgentRegistry();
        await registry.initialize();

        // Check if registry is empty and seed built-in agents
        const existing = await registry.listAll();
        if (existing.length === 0) {
          console.log("[AgentManager] Seeding built-in agents...");
          for (const agent of BUILT_IN_AGENTS) {
            await registry.upsert(agent);
          }
        }

        // Load all agents
        const allAgents = await registry.listAll();
        const defaults = await loadAgentDefaults();

        if (mounted) {
          setAgents(allAgents);
          setAgentDefaults(defaults);
          setStatus(`${allAgents.length} agents registered`);
          setIsLoading(false);
        }
      } catch (err) {
        if (mounted) {
          setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
          setIsLoading(false);
        }
      }
    }

    void init();

    return () => {
      mounted = false;
    };
  }, []);

  // Toggle agent enabled state
  const toggleEnabled = useCallback(async (agentId: string, enabled: boolean) => {
    try {
      const registry = getAgentRegistry();
      await registry.setEnabled(agentId, enabled);

      setAgents((prev) =>
        prev.map((agent) =>
          agent.id === agentId ? { ...agent, enabled } : agent
        )
      );
    } catch (err) {
      console.error("[AgentManager] Failed to toggle enabled:", err);
    }
  }, []);

  // Update a default value for an agent type
  const updateDefault = useCallback((agentTypeId: string, key: string, value: FieldValue) => {
    setAgentDefaults((prev) => {
      const updated = {
        ...prev,
        [agentTypeId]: {
          ...(prev[agentTypeId] ?? {}),
          [key]: value,
        },
      };
      void saveAgentDefaults(agentTypeId, updated[agentTypeId]!);
      return updated;
    });
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
          <Heading size="4">Agent Manager</Heading>
          <Badge size="1" color={isLoading ? "gray" : "green"} variant="soft">
            {status}
          </Badge>
        </Flex>

        <Text size="2" color="gray">
          Manage registered agents. Changes take effect immediately for new chat sessions.
        </Text>

        {/* Agent List */}
        <ScrollArea style={{ flex: 1 }}>
          <Flex direction="column" gap="4" pr="3">
            {agents.length === 0 && !isLoading ? (
              <Card variant="surface">
                <Text size="2" color="gray">
                  No agents registered.
                </Text>
              </Card>
            ) : (
              agents.map((agent) => (
                <Card key={agent.id}>
                  <Flex direction="column" gap="3">
                    {/* Agent header */}
                    <Flex justify="between" align="center">
                      <Flex direction="column" gap="1">
                        <Flex align="center" gap="2">
                          <Text size="4" weight="bold">{agent.name}</Text>
                          <Badge size="1" variant="outline" color="gray">
                            @{agent.proposedHandle}
                          </Badge>
                        </Flex>
                        <Text size="1" color="gray">
                          {agent.workerSource}
                        </Text>
                      </Flex>
                      <Flex align="center" gap="2">
                        <Text size="1" color="gray">Enabled</Text>
                        <Switch
                          checked={agent.enabled}
                          onCheckedChange={(checked) => toggleEnabled(agent.id, checked)}
                        />
                      </Flex>
                    </Flex>

                    <Text size="2" color="gray">{agent.description}</Text>

                    {/* Tags */}
                    {agent.tags && agent.tags.length > 0 && (
                      <Flex gap="1" wrap="wrap">
                        {agent.tags.map((tag) => (
                          <Badge key={tag} size="1" variant="outline">
                            {tag}
                          </Badge>
                        ))}
                      </Flex>
                    )}

                    {/* Parameters - always visible for enabled agents */}
                    {agent.parameters && agent.parameters.length > 0 && (
                      <>
                        <Separator size="4" />
                        <Text size="2" weight="medium" color="gray">
                          Default Parameters
                        </Text>
                        <ParameterEditor
                          parameters={agent.parameters}
                          values={agentDefaults[agent.id] ?? {}}
                          onChange={(key: string, value: FieldValue) =>
                            updateDefault(agent.id, key, value)
                          }
                        />
                      </>
                    )}

                    {/* Required Methods (informational) */}
                    {agent.requiresMethods && agent.requiresMethods.length > 0 && (
                      <>
                        <Separator size="4" />
                        <Text size="2" weight="medium" color="gray">
                          Required Methods
                        </Text>
                        <Flex gap="1" wrap="wrap">
                          {agent.requiresMethods.map((method) => (
                            <Badge
                              key={method.name ?? method.pattern}
                              size="1"
                              color={method.required ? "red" : "gray"}
                              variant="soft"
                            >
                              {method.name ?? method.pattern}
                              {method.required ? " (required)" : " (optional)"}
                            </Badge>
                          ))}
                        </Flex>
                      </>
                    )}
                  </Flex>
                </Card>
              ))
            )}
          </Flex>
        </ScrollArea>

        {/* Footer info */}
        <Flex justify="between" align="center">
          <Text size="1" color="gray">
            {agents.filter((a) => a.enabled).length} of {agents.length} agents enabled
          </Text>
          <Button
            size="1"
            variant="soft"
            onClick={async () => {
              // Re-seed built-in agents
              const registry = getAgentRegistry();
              for (const agent of BUILT_IN_AGENTS) {
                await registry.upsert(agent);
              }
              const allAgents = await registry.listAll();
              setAgents(allAgents);
              setStatus("Built-in agents restored");
            }}
          >
            Reset Built-in Agents
          </Button>
        </Flex>
      </Flex>
    </Box>
  );
}
