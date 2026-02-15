import { useState } from "react";
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Flex,
  ScrollArea,
  Text,
  TextField,
} from "@radix-ui/themes";
import { InfoCircledIcon, ChevronDownIcon, ChevronRightIcon } from "@radix-ui/react-icons";
import { ParameterEditor } from "@workspace/react";
import type { FieldValue } from "@natstack/types";
import type {
  AgentSelectionWithRequirements,
  SessionConfig,
} from "../hooks/useAgentSelection";
import { getPerAgentParams } from "../hooks/useAgentSelection";
import { SessionSettings } from "./SessionSettings";

interface AgentSetupPhaseProps {
  selectionStatus: string;
  availableAgents: AgentSelectionWithRequirements[];
  sessionConfig: SessionConfig;
  channelId: string;
  status: string | null;
  isStarting: boolean;
  /** If true, we are adding agents to an existing channel (not starting a new chat) */
  isChannelMode?: boolean;
  onSessionConfigChange: (config: SessionConfig) => void;
  onChannelIdChange: (channelId: string) => void;
  onToggleAgent: (agentId: string) => void;
  onUpdateConfig: (agentId: string, key: string, value: FieldValue) => void;
  onStartChat: () => void;
}

export function AgentSetupPhase({
  selectionStatus,
  availableAgents,
  sessionConfig,
  channelId,
  status,
  isStarting,
  isChannelMode = false,
  onSessionConfigChange,
  onChannelIdChange,
  onToggleAgent,
  onUpdateConfig,
  onStartChat,
}: AgentSetupPhaseProps) {
  const selectedCount = availableAgents.filter((a) => a.selected).length;
  const isMultiAgent = selectedCount > 1;

  return (
    <Flex direction="column" style={{ height: "100vh", padding: 16 }} gap="3">
      <Flex justify="between" align="center">
        <Text size="5" weight="bold">
          {isChannelMode ? "Add Agents" : "New Chat"}
        </Text>
        <Badge color="gray">{selectionStatus}</Badge>
      </Flex>

      {/* Session Settings - shown only when starting new chat, not in channel mode */}
      {!isChannelMode && (
        <SessionSettings config={sessionConfig} onChange={onSessionConfigChange} />
      )}

      <Card style={{ flex: 1, overflow: "hidden" }}>
        <Flex direction="column" gap="3" p="3" style={{ height: "100%" }}>
          <Text size="3" weight="bold">
            Available Agents
          </Text>
          <Text size="2" color="gray">
            {isChannelMode
              ? "Select additional agents to add to the channel."
              : "Select agents to join your chat session."}
          </Text>

          <ScrollArea style={{ flex: 1 }}>
            {availableAgents.length === 0 ? (
              <Flex direction="column" gap="2" align="center" justify="center" style={{ height: "100%" }}>
                <Text size="2" color="gray">
                  No agents registered.
                </Text>
                <Text size="1" color="gray">
                  Open the Agent Manager panel to register agents.
                </Text>
              </Flex>
            ) : (
              <Flex direction="column" gap="2">
                {availableAgents.map((agent) => (
                  <AgentCard
                    key={agent.agent.id}
                    agent={agent}
                    isMultiAgent={isMultiAgent}
                    onToggle={() => onToggleAgent(agent.agent.id)}
                    onUpdateConfig={(key, value) =>
                      onUpdateConfig(agent.agent.id, key, value)
                    }
                  />
                ))}
              </Flex>
            )}
          </ScrollArea>

          {status && (
            <Text size="2" color="red" style={{ whiteSpace: "pre-wrap" }}>
              {status}
            </Text>
          )}

          <Flex justify="between" align="center">
            <Text size="2" color="gray">
              {selectedCount} agent{selectedCount !== 1 ? "s" : ""} selected
            </Text>
            <Flex gap="2" align="center">
              <Text size="1" color="gray">
                Channel:
              </Text>
              <TextField.Root
                size="1"
                style={{ width: 140 }}
                value={channelId}
                onChange={(e) => onChannelIdChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && selectedCount > 0 && !isStarting) {
                    onStartChat();
                  }
                }}
                disabled={isStarting || isChannelMode}
                readOnly={isChannelMode}
              />
              <Button onClick={onStartChat} disabled={selectedCount === 0 || isStarting}>
                {isStarting
                  ? isChannelMode ? "Adding..." : "Starting..."
                  : isChannelMode ? "Add Agents" : "Start Chat"}
              </Button>
            </Flex>
          </Flex>
        </Flex>
      </Card>
    </Flex>
  );
}

interface AgentCardProps {
  agent: AgentSelectionWithRequirements;
  isMultiAgent: boolean;
  onToggle: () => void;
  onUpdateConfig: (key: string, value: FieldValue) => void;
}

function AgentCard({ agent, isMultiAgent, onToggle, onUpdateConfig }: AgentCardProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const hasUnmetRequirements = agent.unmetRequirements.length > 0;

  // Get per-agent params, filtering out autonomyLevel unless multi-agent mode
  const allPerAgentParams = getPerAgentParams(agent.agent.parameters);
  const perAgentParams = isMultiAgent
    ? allPerAgentParams
    : allPerAgentParams.filter((p) => p.key !== "autonomyLevel");

  // Check if there are any non-autonomy params to show
  const hasNonAutonomyParams = allPerAgentParams.some((p) => p.key !== "autonomyLevel");
  const hasAutonomyParam = allPerAgentParams.some((p) => p.key === "autonomyLevel");

  return (
    <Card variant="surface" style={{ opacity: hasUnmetRequirements ? 0.7 : 1 }}>
      <Flex direction="column" gap="2">
        <Flex
          gap="3"
          align="start"
          style={{ cursor: hasUnmetRequirements ? "not-allowed" : "pointer" }}
          onClick={hasUnmetRequirements ? undefined : onToggle}
          tabIndex={hasUnmetRequirements ? undefined : 0}
        >
          <Checkbox checked={agent.selected} disabled={hasUnmetRequirements} />
          <Flex direction="column" gap="1" style={{ flex: 1 }}>
            <Text weight="medium">{agent.agent.name}</Text>
            <Text size="1" color="gray">
              {agent.agent.description}
            </Text>
            <Flex gap="1" wrap="wrap" mt="1">
              {agent.agent.tags?.map((tag) => (
                <Badge key={tag} size="1" variant="outline">
                  {tag}
                </Badge>
              ))}
            </Flex>
          </Flex>
        </Flex>

        {/* Show unmet requirements warning */}
        {hasUnmetRequirements && (
          <Callout.Root color="amber" size="1" ml="6">
            <Callout.Icon>
              <InfoCircledIcon />
            </Callout.Icon>
            <Callout.Text>
              Requires: {agent.unmetRequirements.join(", ")}
              <br />
              <Text size="1" color="gray">Configure in Session Settings above</Text>
            </Callout.Text>
          </Callout.Root>
        )}

        {/* Parameter inputs - show when agent is selected and has no unmet requirements */}
        {agent.selected && !hasUnmetRequirements && perAgentParams.length > 0 && (
          <Flex direction="column" gap="2" pl="6" pt="2" style={{ borderTop: "1px solid var(--gray-5)" }}>
            {/* In multi-agent mode with autonomy param, show collapsible advanced section */}
            {isMultiAgent && hasAutonomyParam ? (
              <>
                {/* Non-autonomy params shown directly if any */}
                {hasNonAutonomyParams && (
                  <ParameterEditor
                    parameters={perAgentParams.filter((p) => p.key !== "autonomyLevel")}
                    values={agent.config}
                    onChange={onUpdateConfig}
                    size="1"
                    showGroups={false}
                    showRequiredIndicators={true}
                    stopPropagation={true}
                  />
                )}
                {/* Collapsible autonomy override section */}
                <Flex
                  align="center"
                  gap="1"
                  style={{ cursor: "pointer" }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowAdvanced(!showAdvanced);
                  }}
                  tabIndex={0}
                >
                  {showAdvanced ? <ChevronDownIcon /> : <ChevronRightIcon />}
                  <Text size="1" color="gray">
                    Override autonomy for this agent
                  </Text>
                </Flex>
                {showAdvanced && (
                  <Flex pl="4">
                    <ParameterEditor
                      parameters={perAgentParams.filter((p) => p.key === "autonomyLevel")}
                      values={agent.config}
                      onChange={onUpdateConfig}
                      size="1"
                      showGroups={false}
                      showRequiredIndicators={false}
                      stopPropagation={true}
                    />
                  </Flex>
                )}
              </>
            ) : (
              /* Single agent mode or no autonomy param - show all params directly */
              <ParameterEditor
                parameters={perAgentParams}
                values={agent.config}
                onChange={onUpdateConfig}
                size="1"
                showGroups={false}
                showRequiredIndicators={true}
                stopPropagation={true}
              />
            )}
          </Flex>
        )}
      </Flex>
    </Card>
  );
}
