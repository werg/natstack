/**
 * Agent Manager Panel
 *
 * UI for managing agent preferences. Agents are discovered from the filesystem
 * (workspace/agents/). This panel manages:
 * - Global settings (default autonomy, project location)
 * - Per-agent preferences (enabled state, default parameter values)
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
import { db, rpc } from "@natstack/runtime";
import type { FieldValue, AgentManifest } from "@natstack/core";

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

/** Per-agent preferences structure */
interface AgentPreferences {
  /** Whether the agent is enabled for selection */
  enabled: boolean;
  /** Default parameter values */
  defaults: Record<string, FieldValue>;
}

/** Persisted preferences - keyed by agent ID */
type AllAgentPreferences = Record<string, AgentPreferences>;

/** Preferences database singleton */
let preferencesDbPromise: Promise<Awaited<ReturnType<typeof db.open>>> | null = null;

async function getPreferencesDb() {
  if (!preferencesDbPromise) {
    preferencesDbPromise = (async () => {
      const database = await db.open(PREFERENCES_DB_NAME);
      await database.exec(`
        CREATE TABLE IF NOT EXISTS agent_preferences (
          agent_id TEXT PRIMARY KEY,
          enabled INTEGER DEFAULT 1,
          defaults TEXT NOT NULL DEFAULT '{}',
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

/** Load all agent preferences from SQLite */
async function loadAgentPreferences(): Promise<AllAgentPreferences> {
  try {
    const database = await getPreferencesDb();
    const rows = await database.query<{
      agent_id: string;
      enabled: number;
      defaults: string;
    }>("SELECT agent_id, enabled, defaults FROM agent_preferences");

    const result: AllAgentPreferences = {};
    for (const row of rows) {
      try {
        result[row.agent_id] = {
          enabled: row.enabled === 1,
          defaults: JSON.parse(row.defaults),
        };
      } catch {
        // Skip malformed entries
      }
    }
    return result;
  } catch (err) {
    console.warn("[AgentManager] Failed to load preferences:", err);
    return {};
  }
}

/** Save preferences for a specific agent */
async function saveAgentPreferences(
  agentId: string,
  prefs: AgentPreferences
): Promise<void> {
  try {
    const database = await getPreferencesDb();
    const defaultsJson = JSON.stringify(prefs.defaults);
    const now = Date.now();
    await database.run(
      `INSERT INTO agent_preferences (agent_id, enabled, defaults, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(agent_id) DO UPDATE SET enabled = ?, defaults = ?, updated_at = ?`,
      [agentId, prefs.enabled ? 1 : 0, defaultsJson, now, prefs.enabled ? 1 : 0, defaultsJson, now]
    );
  } catch (err) {
    console.warn("[AgentManager] Failed to save preferences:", err);
  }
}

export default function AgentManager() {
  const theme = usePanelTheme();
  const [agents, setAgents] = useState<AgentManifest[]>([]);
  const [preferences, setPreferences] = useState<AllAgentPreferences>({});
  const [globalSettings, setGlobalSettings] = useState<GlobalAgentSettings>(DEFAULT_GLOBAL_SETTINGS);
  const [status, setStatus] = useState("Loading...");
  const [isLoading, setIsLoading] = useState(true);

  // Load agents from Discovery and preferences from DB
  useEffect(() => {
    let mounted = true;

    async function init() {
      try {
        // Load agents from Discovery via bridge
        const manifests = await rpc.call<AgentManifest[]>("main", "bridge.listAgents");
        const prefs = await loadAgentPreferences();
        const global = await loadGlobalSettings();

        if (mounted) {
          setAgents(manifests);
          setPreferences(prefs);
          setGlobalSettings(global);
          setStatus(`${manifests.length} agents discovered`);
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

  // Get preferences for an agent (with defaults)
  const getAgentPrefs = useCallback(
    (agentId: string): AgentPreferences => {
      return preferences[agentId] ?? { enabled: true, defaults: {} };
    },
    [preferences]
  );

  // Update a global setting
  const updateGlobalSetting = useCallback(
    <K extends keyof GlobalAgentSettings>(key: K, value: GlobalAgentSettings[K]) => {
      setGlobalSettings((prev) => ({ ...prev, [key]: value }));
      void saveGlobalSetting(key, value);
    },
    []
  );

  // Toggle agent enabled state
  const toggleEnabled = useCallback(
    (agentId: string, enabled: boolean) => {
      setPreferences((prev) => {
        const current = prev[agentId] ?? { enabled: true, defaults: {} };
        const updated = { ...current, enabled };
        void saveAgentPreferences(agentId, updated);
        return { ...prev, [agentId]: updated };
      });
    },
    []
  );

  // Update a default value for an agent
  const updateDefault = useCallback(
    (agentId: string, key: string, value: FieldValue) => {
      setPreferences((prev) => {
        const current = prev[agentId] ?? { enabled: true, defaults: {} };
        const updated = {
          ...current,
          defaults: { ...current.defaults, [key]: value },
        };
        void saveAgentPreferences(agentId, updated);
        return { ...prev, [agentId]: updated };
      });
    },
    []
  );

  // Count enabled agents
  const enabledCount = agents.filter((a) => getAgentPrefs(a.id).enabled).length;

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
          Manage agent preferences. Agents are discovered from workspace/agents/.
        </Text>

        {/* Global Settings */}
        <Card variant="surface">
          <Flex direction="column" gap="3" p="2">
            <Text size="2" weight="bold">
              Global Defaults
            </Text>
            <Text size="1" color="gray">
              These defaults apply to all new sessions unless overridden.
            </Text>

            <Flex direction="column" gap="2">
              <Text size="2" weight="medium">
                Default Project Location
              </Text>
              <SegmentedControl.Root
                value={globalSettings.defaultProjectLocation}
                onValueChange={(value) =>
                  updateGlobalSetting("defaultProjectLocation", value as "external" | "browser")
                }
              >
                <SegmentedControl.Item value="external">External Filesystem</SegmentedControl.Item>
                <SegmentedControl.Item value="browser">Browser Storage</SegmentedControl.Item>
              </SegmentedControl.Root>
              <Text size="1" color="gray">
                {globalSettings.defaultProjectLocation === "external"
                  ? "Agents have native filesystem access to your local machine."
                  : "Agents run in a sandboxed browser environment with limited filesystem access."}
              </Text>
            </Flex>

            <Flex direction="column" gap="2">
              <Text size="2" weight="medium">
                Default Autonomy Level
              </Text>
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
                  No agents found in workspace/agents/. Create an agent directory with a package.json
                  containing natstack.type = "agent".
                </Text>
              </Card>
            ) : (
              agents.map((agent) => {
                const prefs = getAgentPrefs(agent.id);
                return (
                  <Card key={agent.id}>
                    <Flex direction="column" gap="3">
                      {/* Agent header */}
                      <Flex justify="between" align="center">
                        <Flex direction="column" gap="1">
                          <Flex align="center" gap="2">
                            <Text size="4" weight="bold">
                              {agent.name}
                            </Text>
                            {agent.proposedHandle && (
                              <Badge size="1" variant="outline" color="gray">
                                @{agent.proposedHandle}
                              </Badge>
                            )}
                          </Flex>
                          <Text size="1" color="gray">
                            {agent.id} v{agent.version}
                          </Text>
                        </Flex>
                        <Flex align="center" gap="2">
                          <Text size="1" color="gray">
                            Enabled
                          </Text>
                          <Switch
                            checked={prefs.enabled}
                            onCheckedChange={(checked) => toggleEnabled(agent.id, checked)}
                          />
                        </Flex>
                      </Flex>

                      {agent.description && (
                        <Text size="2" color="gray">
                          {agent.description}
                        </Text>
                      )}

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

                      {/* Parameters */}
                      {agent.parameters && agent.parameters.length > 0 && (
                        <>
                          <Separator size="4" />
                          <Text size="2" weight="medium" color="gray">
                            Default Parameters
                          </Text>
                          <ParameterEditor
                            parameters={agent.parameters}
                            values={prefs.defaults}
                            onChange={(key: string, value: FieldValue) => updateDefault(agent.id, key, value)}
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
                );
              })
            )}
          </Flex>
        </ScrollArea>

        {/* Footer info */}
        <Flex justify="between" align="center">
          <Text size="1" color="gray">
            {enabledCount} of {agents.length} agents enabled
          </Text>
        </Flex>
      </Flex>
    </Box>
  );
}
