import { useState, useEffect, useCallback, useMemo } from "react";
import { db, type FieldDefinition } from "@natstack/runtime";
import type { ChannelConfig } from "@natstack/pubsub";
import { getAgentRegistry, type AgentDefinition } from "@natstack/agentic-messaging/registry";

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
    console.warn("[useAgentSelection] Failed to load persisted settings:", err);
    return {};
  }
}

/**
 * Session configuration - what chat-launcher tracks locally.
 * ChannelConfig = subset that gets persisted with the channel.
 */
export interface SessionConfig {
  projectLocation: "external" | "browser";
  workingDirectory: string;
  defaultAutonomy: 0 | 1 | 2;
  /** Selected template spec for browser mode (e.g., "contexts/default") */
  contextTemplateSpec?: string;
}

/** Derive ChannelConfig from SessionConfig */
export function toChannelConfig(session: SessionConfig): ChannelConfig {
  return {
    workingDirectory: session.workingDirectory || undefined,
    restrictedMode: session.projectLocation === "browser",
  };
}

export const DEFAULT_SESSION_CONFIG: SessionConfig = {
  projectLocation: "external",
  workingDirectory: "",
  defaultAutonomy: 0,
};

/** Agent selection state */
export interface AgentSelection {
  agent: AgentDefinition;
  selected: boolean;
  /** Parameter values configured by user (per-agent params only) */
  config: Record<string, string | number | boolean>;
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
        const registry = getAgentRegistry();
        await registry.initialize();
        const enabledAgents = await registry.listEnabled();
        const persistedSettings = await loadPersistedSettings();

        if (!mounted) return;

        const agents: AgentSelection[] = [];

        for (const agentDef of enabledAgents) {
          // Build config for per-agent params only (not channelLevel - those come from channel config)
          const config: Record<string, string | number | boolean> = {};
          const persisted = persistedSettings[agentDef.id] ?? {};
          const perAgentParams = getPerAgentParams(agentDef.parameters);

          for (const param of perAgentParams) {
            // Skip autonomyLevel - it uses session default unless explicitly overridden
            if (param.key === "autonomyLevel") continue;

            // Check persisted settings first
            if (param.key in persisted) {
              config[param.key] = persisted[param.key]!;
            } else if (param.default !== undefined) {
              // Fall back to parameter default (convert to the expected type)
              config[param.key] = param.default as string | number | boolean;
            }
          }

          agents.push({
            agent: agentDef,
            selected: false,
            config,
          });
        }

        setAvailableAgents(agents);
        setSelectionStatus(agents.length > 0 ? "Ready" : "No agents registered");
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
    (agentId: string, key: string, value: string | number | boolean) => {
      // Update local state only - defaults are managed by Agent Manager
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
