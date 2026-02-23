import { useState, useEffect, useCallback, useMemo } from "react";
import { rpc } from "@workspace/runtime";
import type { FieldDefinition, FieldValue, AgentManifest, AgentSettings } from "@natstack/types";
import type { ChannelConfig } from "@workspace/pubsub";

/**
 * Session configuration - what chat-launcher tracks locally.
 * ChannelConfig = subset that gets persisted with the channel.
 */
export interface SessionConfig {
  projectLocation: "external" | "browser";
  /** Working directory for external/native filesystem mode */
  workingDirectory: string;
  /** Working directory for browser/OPFS mode (defaults to "/") */
  browserWorkingDirectory: string;
  defaultAutonomy: 0 | 1 | 2;
}

/** Derive ChannelConfig from SessionConfig */
export function toChannelConfig(session: SessionConfig): ChannelConfig {
  const isRestricted = session.projectLocation === "browser";
  // Use the appropriate working directory based on mode
  const workingDir = isRestricted
    ? session.browserWorkingDirectory
    : session.workingDirectory;
  return {
    workingDirectory: workingDir || undefined,
    restrictedMode: isRestricted,
  };
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  projectLocation: "external",
  workingDirectory: "",
  browserWorkingDirectory: "/",
  defaultAutonomy: 2,
};

/** Agent selection state */
export interface AgentSelection {
  agent: AgentManifest;
  selected: boolean;
  /** Parameter values configured by user (per-agent params only) */
  config: Record<string, FieldValue>;
}

/** Agent selection with computed unmet requirements */
export interface AgentSelectionWithRequirements extends AgentSelection {
  /** Channel-level requirements not satisfied, e.g., ["workingDirectory"] */
  unmetRequirements: string[];
}

/**
 * Check if agent's channel requirements are satisfied.
 * Returns array of parameter keys that have channelLevel=true, required=true, but missing values.
 */
function checkChannelRequirements(
  params: FieldDefinition[] | undefined,
  channelConfig: ChannelConfig
): string[] {
  const unmet: string[] = [];
  for (const param of params ?? []) {
    if (param.channelLevel && param.required) {
      const value = channelConfig[param.key as keyof ChannelConfig];
      if (value === undefined || value === "") {
        unmet.push(param.key);
      }
    }
  }
  return unmet;
}

/**
 * Get only per-agent params (not channelLevel).
 * These are the params that get user input in the agent config form.
 */
export function getPerAgentParams(params: FieldDefinition[] | undefined): FieldDefinition[] {
  return (params ?? []).filter((p) => !p.channelLevel);
}

interface UseAgentSelectionOptions {
  workspaceRoot?: string;
  sessionConfig?: SessionConfig;
}

export function useAgentSelection({ workspaceRoot, sessionConfig = DEFAULT_SESSION_CONFIG }: UseAgentSelectionOptions = {}) {
  const [availableAgents, setAvailableAgents] = useState<AgentSelection[]>([]);
  const [selectionStatus, setSelectionStatus] = useState("Loading agents...");

  // Compute agents with requirements - recomputes when sessionConfig changes
  const agentsWithRequirements = useMemo((): AgentSelectionWithRequirements[] => {
    const channelConfig = toChannelConfig(sessionConfig);
    return availableAgents.map((agent) => ({
      ...agent,
      unmetRequirements: checkChannelRequirements(agent.agent.parameters, channelConfig),
    }));
  }, [availableAgents, sessionConfig]);

  useEffect(() => {
    let mounted = true;

    async function loadAgents() {
      try {
        // Get agents from AgentDiscovery via bridge and settings via agentSettings service
        const [manifests, allSettings] = await Promise.all([
          rpc.call<AgentManifest[]>("main", "bridge.listAgents"),
          rpc.call<Record<string, AgentSettings>>("main", "agentSettings.getAllAgentSettings"),
        ]);

        if (!mounted) return;

        const agents: AgentSelection[] = [];

        for (const manifest of manifests) {
          // Build config for per-agent params only (not channelLevel - those come from channel config)
          const config: Record<string, FieldValue> = {};
          const persisted = allSettings[manifest.id] ?? {};
          const perAgentParams = getPerAgentParams(manifest.parameters);

          for (const param of perAgentParams) {
            // Check persisted settings first
            if (param.key in persisted) {
              config[param.key] = persisted[param.key] as FieldValue;
            } else if (param.default !== undefined) {
              // Fall back to parameter default (convert to the expected type)
              config[param.key] = param.default as string | number | boolean;
            }
          }

          agents.push({
            agent: manifest,
            selected: false,
            config,
          });
        }

        setAvailableAgents(agents);
        setSelectionStatus(agents.length > 0 ? "Ready" : "No agents found");
      } catch (err) {
        if (mounted) {
          setSelectionStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    void loadAgents();

    return () => {
      mounted = false;
    };
  }, [workspaceRoot]);

  const toggleAgentSelection = useCallback((agentId: string) => {
    setAvailableAgents((prev) =>
      prev.map((agent) =>
        agent.agent.id === agentId
          ? { ...agent, selected: !agent.selected }
          : agent
      )
    );
  }, []);

  const updateAgentConfig = useCallback(
    (agentId: string, key: string, value: FieldValue) => {
      // Update local state only - defaults are managed via ns-about://agents
      setAvailableAgents((prev) =>
        prev.map((agent) =>
          agent.agent.id === agentId
            ? { ...agent, config: { ...agent.config, [key]: value } }
            : agent
        )
      );
    },
    []
  );

  const buildSpawnConfig = useCallback(
    (agent: AgentSelection) => {
      const result: Record<string, unknown> = {};
      // Only include per-agent params (not channelLevel - those come from channel config)
      const perAgentParams = getPerAgentParams(agent.agent.parameters);

      for (const param of perAgentParams) {
        if (param.key === "autonomyLevel") {
          // autonomyLevel: use per-agent override if set, else session default
          const userValue = agent.config[param.key];
          result[param.key] = userValue !== undefined ? userValue : sessionConfig.defaultAutonomy;
        } else {
          const userValue = agent.config[param.key];
          if (userValue !== undefined && userValue !== "") {
            result[param.key] = userValue;
          } else if (param.default !== undefined) {
            result[param.key] = param.default;
          }
        }
      }

      return result;
    },
    [sessionConfig.defaultAutonomy]
  );

  return {
    availableAgents,
    agentsWithRequirements,
    selectionStatus,
    toggleAgentSelection,
    updateAgentConfig,
    buildSpawnConfig,
  };
}
