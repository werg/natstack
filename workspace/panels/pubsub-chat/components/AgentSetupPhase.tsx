import {
  Badge,
  Button,
  Card,
  Checkbox,
  Flex,
  ScrollArea,
  Text,
  TextField,
} from "@radix-ui/themes";
import { ParameterEditor } from "@natstack/react";
import type { AgentSelection } from "../hooks/useDiscovery";

interface AgentSetupPhaseProps {
  discoveryStatus: string;
  availableAgents: AgentSelection[];
  channelId: string;
  onChannelIdChange: (channelId: string) => void;
  onToggleAgent: (brokerId: string, agentTypeId: string) => void;
  onUpdateConfig: (brokerId: string, agentTypeId: string, key: string, value: string | number | boolean) => void;
  onStartChat: () => void;
}

export function AgentSetupPhase({
  discoveryStatus,
  availableAgents,
  channelId,
  onChannelIdChange,
  onToggleAgent,
  onUpdateConfig,
  onStartChat,
}: AgentSetupPhaseProps) {
  const selectedCount = availableAgents.filter((a) => a.selected).length;

  return (
    <Flex direction="column" style={{ height: "100vh", padding: 16 }} gap="3">
      <Flex justify="between" align="center">
        <Text size="5" weight="bold">
          Agentic Chat
        </Text>
        <Badge color="gray">{discoveryStatus}</Badge>
      </Flex>

      <Card style={{ flex: 1, overflow: "hidden" }}>
        <Flex direction="column" gap="3" p="3" style={{ height: "100%" }}>
          <Text size="3" weight="bold">
            Available Agents
          </Text>
          <Text size="2" color="gray">
            Select agents to invite to your chat session. Make sure Agent Manager is running.
          </Text>

          <ScrollArea style={{ flex: 1 }}>
            {availableAgents.length === 0 ? (
              <Flex direction="column" gap="2" align="center" justify="center" style={{ height: "100%" }}>
                <Text size="2" color="gray">
                  No agents available.
                </Text>
                <Text size="1" color="gray">
                  Start the Agent Manager panel to advertise agents.
                </Text>
              </Flex>
            ) : (
              <Flex direction="column" gap="2">
                {availableAgents.map((agent) => (
                  <AgentCard
                    key={`${agent.broker.brokerId}-${agent.agentType.id}`}
                    agent={agent}
                    onToggle={() => onToggleAgent(agent.broker.brokerId, agent.agentType.id)}
                    onUpdateConfig={(key, value) =>
                      onUpdateConfig(agent.broker.brokerId, agent.agentType.id, key, value)
                    }
                  />
                ))}
              </Flex>
            )}
          </ScrollArea>

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
                  if (e.key === "Enter" && selectedCount > 0) {
                    onStartChat();
                  }
                }}
              />
              <Button onClick={onStartChat} disabled={selectedCount === 0}>
                Start Chat
              </Button>
            </Flex>
          </Flex>
        </Flex>
      </Card>
    </Flex>
  );
}

interface AgentCardProps {
  agent: AgentSelection;
  onToggle: () => void;
  onUpdateConfig: (key: string, value: string | number | boolean) => void;
}

function AgentCard({ agent, onToggle, onUpdateConfig }: AgentCardProps) {
  return (
    <Card variant="surface">
      <Flex direction="column" gap="2">
        <Flex gap="3" align="start" style={{ cursor: "pointer" }} onClick={onToggle}>
          <Checkbox checked={agent.selected} />
          <Flex direction="column" gap="1" style={{ flex: 1 }}>
            <Text weight="medium">{agent.agentType.name}</Text>
            <Text size="1" color="gray">
              {agent.agentType.description}
            </Text>
            <Flex gap="1" wrap="wrap" mt="1">
              {agent.agentType.tags?.map((tag) => (
                <Badge key={tag} size="1" variant="outline">
                  {tag}
                </Badge>
              ))}
            </Flex>
          </Flex>
        </Flex>

        {/* Parameter inputs - show when agent is selected and has parameters */}
        {agent.selected && agent.agentType.parameters && agent.agentType.parameters.length > 0 && (
          <Flex direction="column" gap="2" pl="6" pt="2" style={{ borderTop: "1px solid var(--gray-5)" }}>
            <ParameterEditor
              parameters={agent.agentType.parameters}
              values={agent.config}
              onChange={onUpdateConfig}
              size="1"
              showGroups={false}
              showRequiredIndicators={true}
              stopPropagation={true}
            />
          </Flex>
        )}
      </Flex>
    </Card>
  );
}
