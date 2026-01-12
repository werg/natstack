import { useState, useEffect, useRef, useCallback } from "react";
import { pubsubConfig, db } from "@natstack/runtime";
import {
  connectForDiscovery,
  type BrokerDiscoveryClient,
  type DiscoveredBroker,
  type AgentTypeAdvertisement,
} from "@natstack/agentic-messaging";

const AVAILABILITY_CHANNEL = "agent-availability";
const PREFERENCES_DB_NAME = "agent-preferences";

/** Persisted settings structure - keyed by agent type ID */
type PersistedSettings = Record<string, Record<string, string | number | boolean>>;

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

/** Load persisted settings from SQLite */
async function loadPersistedSettings(): Promise<PersistedSettings> {
  try {
    const database = await getPreferencesDb();
    const rows = await database.query<{ agent_type_id: string; settings: string }>(
      "SELECT agent_type_id, settings FROM agent_preferences"
    );
    const result: PersistedSettings = {};
    for (const row of rows) {
      try {
        result[row.agent_type_id] = JSON.parse(row.settings);
      } catch {
        // Skip malformed entries
      }
    }
    return result;
  } catch (err) {
    console.warn("[useDiscovery] Failed to load persisted settings:", err);
    return {};
  }
}

/** Agent selection state */
export interface AgentSelection {
  broker: DiscoveredBroker;
  agentType: AgentTypeAdvertisement;
  selected: boolean;
  /** Parameter values configured by user */
  config: Record<string, string | number | boolean>;
}

interface UseDiscoveryOptions {
  workspaceRoot?: string;
}

export function useDiscovery({ workspaceRoot }: UseDiscoveryOptions = {}) {
  const [availableAgents, setAvailableAgents] = useState<AgentSelection[]>([]);
  const [discoveryStatus, setDiscoveryStatus] = useState("Connecting to discovery...");
  const discoveryRef = useRef<BrokerDiscoveryClient | null>(null);

  useEffect(() => {
    if (!pubsubConfig) {
      setDiscoveryStatus("Error: PubSub not available");
      return;
    }

    let mounted = true;
    let unsubBrokersChanged: (() => void) | null = null;

    async function initDiscovery() {
      try {
        const discovery = await connectForDiscovery(pubsubConfig!.serverUrl, pubsubConfig!.token, {
          availabilityChannel: AVAILABILITY_CHANNEL,
          name: "Chat Panel",
          handle: "chat-panel",
          type: "panel",
        });

        if (!mounted) {
          discovery.close();
          return;
        }

        discoveryRef.current = discovery;

        // Initial broker discovery
        await updateAvailableAgents(discovery);

        // Subscribe to changes and store unsubscribe function
        unsubBrokersChanged = discovery.onBrokersChanged(() => {
          if (mounted) {
            void updateAvailableAgents(discovery);
          }
        });

        setDiscoveryStatus("Connected to discovery");
      } catch (err) {
        if (mounted) {
          setDiscoveryStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    async function updateAvailableAgents(discovery: BrokerDiscoveryClient) {
      const brokers = discovery.discoverBrokers();
      const agents: AgentSelection[] = [];
      const persistedSettings = await loadPersistedSettings();

      for (const broker of brokers) {
        for (const agentType of broker.agentTypes) {
          // Build config with precedence: persisted > workspaceRoot > parameter defaults
          const config: Record<string, string | number | boolean> = {};
          const persisted = persistedSettings[agentType.id] ?? {};

          for (const param of agentType.parameters ?? []) {
            // Check persisted settings first
            if (param.key in persisted) {
              config[param.key] = persisted[param.key];
            } else if (param.key === "workingDirectory" && workspaceRoot) {
              // Use workspaceRoot for workingDirectory if not persisted
              config[param.key] = workspaceRoot;
            } else if (param.default !== undefined) {
              // Fall back to parameter default
              config[param.key] = param.default;
            }
          }

          agents.push({
            broker,
            agentType,
            selected: false,
            config,
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
      unsubBrokersChanged?.();
      discoveryRef.current?.close();
      discoveryRef.current = null;
    };
  }, [workspaceRoot]);

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
      // Update local state only - defaults are managed by Agent Manager
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

  return {
    discoveryRef,
    availableAgents,
    discoveryStatus,
    toggleAgentSelection,
    updateAgentConfig,
    buildInviteConfig,
  };
}
