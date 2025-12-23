import { useState, useEffect, useRef, useCallback } from "react";
import { pubsubConfig } from "@natstack/runtime";
import {
  connectForDiscovery,
  type BrokerDiscoveryClient,
  type DiscoveredBroker,
  type AgentTypeAdvertisement,
} from "@natstack/agentic-messaging";

const AVAILABILITY_CHANNEL = "agent-availability";

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
        updateAvailableAgents(discovery);

        // Subscribe to changes and store unsubscribe function
        unsubBrokersChanged = discovery.onBrokersChanged(() => {
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
