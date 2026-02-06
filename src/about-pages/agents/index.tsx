/**
 * Agents Configuration Page - Shell panel for agent settings.
 *
 * This is a shell panel with full access to shell services.
 * It provides UI for configuring global agent settings and per-agent defaults.
 */

import { useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import {
  Theme,
  Card,
  Flex,
  Heading,
  Text,
  Box,
  Separator,
  Badge,
  Spinner,
  SegmentedControl,
  ScrollArea,
} from "@radix-ui/themes";
import { rpc } from "@natstack/runtime";
import { usePanelTheme, ParameterEditor } from "@natstack/react";
import { filterPerAgentParameters } from "@natstack/agentic-messaging/config";
import type { AgentManifest, GlobalAgentSettings, AgentSettings, FieldValue } from "@natstack/core";

/** Default global settings (fallback if service fails) */
const DEFAULT_GLOBAL_SETTINGS: GlobalAgentSettings = {
  defaultProjectLocation: "external",
  defaultAutonomy: 2,
};

function AgentsConfigPage() {
  const [agents, setAgents] = useState<AgentManifest[]>([]);
  const [globalSettings, setGlobalSettings] = useState<GlobalAgentSettings>(DEFAULT_GLOBAL_SETTINGS);
  const [agentSettings, setAgentSettings] = useState<Record<string, AgentSettings>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load all data
  const loadData = async () => {
    try {
      setLoading(true);
      setError(null);

      // Load agents and settings in parallel
      const [agentList, global, allSettings] = await Promise.all([
        rpc.call<AgentManifest[]>("main", "bridge.listAgents"),
        rpc.call<GlobalAgentSettings>("main", "agentSettings.getGlobalSettings"),
        rpc.call<Record<string, AgentSettings>>("main", "agentSettings.getAllAgentSettings"),
      ]);

      setAgents(agentList);
      setGlobalSettings(global);
      setAgentSettings(allSettings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Initial load
  useEffect(() => {
    loadData();
  }, []);

  // Update a global setting
  const updateGlobalSetting = useCallback(
    async <K extends keyof GlobalAgentSettings>(key: K, value: GlobalAgentSettings[K]) => {
      // Optimistically update UI
      setGlobalSettings((prev) => ({ ...prev, [key]: value }));

      try {
        await rpc.call<void>("main", "agentSettings.setGlobalSetting", key, value);
      } catch (err) {
        console.error("Failed to save global setting:", err);
        // Revert on error
        loadData();
      }
    },
    []
  );

  // Update a setting for a specific agent
  const updateAgentSetting = useCallback(
    async (agentId: string, key: string, value: FieldValue) => {
      // Compute new settings and use for both optimistic update AND RPC call
      // This avoids stale closure issues when settings change rapidly
      let newSettings: AgentSettings = {};

      setAgentSettings((prev) => {
        const currentSettings = prev[agentId] ?? {};
        newSettings = { ...currentSettings, [key]: value };
        return { ...prev, [agentId]: newSettings };
      });

      try {
        await rpc.call<void>("main", "agentSettings.setAgentSettings", agentId, newSettings);
      } catch (err) {
        console.error("Failed to save agent setting:", err);
        // Revert on error
        loadData();
      }
    },
    []
  );

  if (loading) {
    return (
      <Flex align="center" justify="center" gap="2" style={{ height: "100vh" }}>
        <Spinner />
        <Text>Loading agent settings...</Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Flex align="center" justify="center" direction="column" gap="3" style={{ height: "100vh" }}>
        <Text color="red">Error: {error}</Text>
      </Flex>
    );
  }

  return (
    <Box p="4" style={{ height: "100vh", display: "flex", flexDirection: "column" }}>
      <Heading size="7" mb="2">Agent Settings</Heading>
      <Text size="2" color="gray" mb="4">
        Configure default settings for agents. These defaults apply to new sessions unless overridden.
      </Text>

      {/* Global Settings */}
      <Card mb="4">
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
          {agents.length === 0 ? (
            <Card variant="surface">
              <Text size="2" color="gray">
                No agents found in workspace/agents/. Create an agent directory with a package.json
                containing natstack.type = "agent".
              </Text>
            </Card>
          ) : (
            agents.map((agent) => {
              const settings = agentSettings[agent.id] ?? {};
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

                    {/* Parameters (excluding channelLevel which are set in session settings) */}
                    {agent.parameters && filterPerAgentParameters(agent.parameters).length > 0 && (
                      <>
                        <Separator size="4" />
                        <Text size="2" weight="medium" color="gray">
                          Default Parameters
                        </Text>
                        <ParameterEditor
                          parameters={filterPerAgentParameters(agent.parameters)}
                          values={settings as Record<string, FieldValue>}
                          onChange={(key: string, value: FieldValue) =>
                            updateAgentSetting(agent.id, key, value)
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
              );
            })
          )}
        </Flex>
      </ScrollArea>

      {/* Footer info */}
      <Flex justify="between" align="center" mt="3">
        <Text size="1" color="gray">
          {agents.length} agent{agents.length !== 1 ? "s" : ""} discovered
        </Text>
      </Flex>
    </Box>
  );
}

function ThemedApp() {
  const theme = usePanelTheme();
  return (
    <Theme appearance={theme} radius="medium">
      <AgentsConfigPage />
    </Theme>
  );
}

// Mount the app
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<ThemedApp />);
}
