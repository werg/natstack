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
  SegmentedControl,
} from "@radix-ui/themes";
import { usePanelTheme, ParameterEditor } from "@natstack/react";
import { db } from "@natstack/runtime";
import { setDbOpen } from "@natstack/agentic-messaging";

// Configure agentic-messaging to use runtime's db
setDbOpen(db.open);

import type { FieldValue, FieldDefinition } from "@natstack/core";
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

/** Global settings that apply across all sessions unless overridden */
export interface GlobalAgentSettings {
  /** Default project location mode for new sessions */
  defaultProjectLocation: "external" | "browser";
  /** Default autonomy level for agents */
  defaultAutonomy: 0 | 1 | 2;
}

/** Default global settings */
export const DEFAULT_GLOBAL_SETTINGS: GlobalAgentSettings = {
  defaultProjectLocation: "external",
  defaultAutonomy: 2,
};

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
      // Global settings table
      await database.exec(`
        CREATE TABLE IF NOT EXISTS global_settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      return database;
    })();
  }
  return preferencesDbPromise;
}

/** Load global settings from SQLite */
export async function loadGlobalSettings(): Promise<GlobalAgentSettings> {
  try {
    const database = await getPreferencesDb();
    const rows = await database.query<{ key: string; value: string }>(
      "SELECT key, value FROM global_settings"
    );
    const result: Partial<GlobalAgentSettings> = {};
    for (const row of rows) {
      try {
        (result as Record<string, unknown>)[row.key] = JSON.parse(row.value);
      } catch {
        // Skip malformed entries
      }
    }
    return { ...DEFAULT_GLOBAL_SETTINGS, ...result };
  } catch (err) {
    console.warn("[AgentManager] Failed to load global settings:", err);
    return { ...DEFAULT_GLOBAL_SETTINGS };
  }
}

/** Save a global setting to SQLite */
export async function saveGlobalSetting(
  key: keyof GlobalAgentSettings,
  value: GlobalAgentSettings[typeof key]
): Promise<void> {
  try {
    const database = await getPreferencesDb();
    const valueJson = JSON.stringify(value);
    const now = Date.now();
    await database.run(
      `INSERT INTO global_settings (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = ?`,
      [key, valueJson, now, valueJson, now]
    );
  } catch (err) {
    console.warn("[AgentManager] Failed to save global setting:", err);
  }
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
    sortOrder: 1,
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
    sortOrder: 2,
  },
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
    sortOrder: 3,
  },
];

export default function AgentManager() {
  const theme = usePanelTheme();
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [agentDefaults, setAgentDefaults] = useState<AgentDefaults>({});
  const [globalSettings, setGlobalSettings] = useState<GlobalAgentSettings>(DEFAULT_GLOBAL_SETTINGS);
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

        // Load all agents and settings
        const allAgents = await registry.listAll();
        const defaults = await loadAgentDefaults();
        const global = await loadGlobalSettings();

        if (mounted) {
          setAgents(allAgents);
          setAgentDefaults(defaults);
          setGlobalSettings(global);
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

  // Update a global setting
  const updateGlobalSetting = useCallback(<K extends keyof GlobalAgentSettings>(
    key: K,
    value: GlobalAgentSettings[K]
  ) => {
    setGlobalSettings((prev) => ({ ...prev, [key]: value }));
    void saveGlobalSetting(key, value);
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

        {/* Global Settings */}
        <Card variant="surface">
          <Flex direction="column" gap="3" p="2">
            <Text size="2" weight="bold">Global Defaults</Text>
            <Text size="1" color="gray">
              These defaults apply to all new sessions unless overridden in project or session settings.
            </Text>

            <Flex direction="column" gap="2">
              <Text size="2" weight="medium">Default Project Location</Text>
              <SegmentedControl.Root
                value={globalSettings.defaultProjectLocation}
                onValueChange={(value) =>
                  updateGlobalSetting("defaultProjectLocation", value as "external" | "browser")
                }
              >
                <SegmentedControl.Item value="external">
                  External Filesystem
                </SegmentedControl.Item>
                <SegmentedControl.Item value="browser">
                  Browser Storage (Restricted)
                </SegmentedControl.Item>
              </SegmentedControl.Root>
              <Text size="1" color="gray">
                {globalSettings.defaultProjectLocation === "external"
                  ? "Agents have native filesystem access to your local machine."
                  : "Agents run in a sandboxed browser environment with limited filesystem access."}
              </Text>
            </Flex>

            <Flex direction="column" gap="2">
              <Text size="2" weight="medium">Default Autonomy Level</Text>
              <SegmentedControl.Root
                value={String(globalSettings.defaultAutonomy)}
                onValueChange={(value) =>
                  updateGlobalSetting("defaultAutonomy", Number(value) as 0 | 1 | 2)
                }
              >
                <SegmentedControl.Item value="0">Restricted</SegmentedControl.Item>
                <SegmentedControl.Item value="1">Standard</SegmentedControl.Item>
                <SegmentedControl.Item value="2">Autonomous</SegmentedControl.Item>
              </SegmentedControl.Root>
              <Text size="1" color="gray">
                {globalSettings.defaultAutonomy === 0 && "Read-only access, requires approval for all actions."}
                {globalSettings.defaultAutonomy === 1 && "Can modify workspace files with standard permissions."}
                {globalSettings.defaultAutonomy === 2 && "Full access with minimal restrictions."}
              </Text>
            </Flex>
          </Flex>
        </Card>

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
