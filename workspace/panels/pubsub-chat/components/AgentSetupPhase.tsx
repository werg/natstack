import {
  Badge,
  Button,
  Card,
  Checkbox,
  Flex,
  ScrollArea,
  Select,
  Text,
  TextField,
} from "@radix-ui/themes";
import type { AgentSelection } from "../hooks/useDiscovery";

interface AgentSetupPhaseProps {
  discoveryStatus: string;
  availableAgents: AgentSelection[];
  onToggleAgent: (brokerId: string, agentTypeId: string) => void;
  onUpdateConfig: (brokerId: string, agentTypeId: string, key: string, value: string | number | boolean) => void;
  onStartChat: () => void;
}

export function AgentSetupPhase({
  discoveryStatus,
  availableAgents,
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
            <Button onClick={onStartChat} disabled={selectedCount === 0}>
              Start Chat
            </Button>
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
            {agent.agentType.parameters.map((param) => {
              // Build placeholder text with default value info
              const placeholderText = param.placeholder
                ? param.default !== undefined
                  ? `${param.placeholder} (default: ${param.default})`
                  : param.placeholder
                : param.default !== undefined
                  ? `Default: ${param.default}`
                  : undefined;

              return (
                <Flex key={param.key} direction="column" gap="1">
                  <Text size="1" weight="medium">
                    {param.label}
                    {param.required ? (
                      <span style={{ color: "var(--red-9)" }}> *</span>
                    ) : (
                      <span style={{ color: "var(--gray-9)", fontWeight: "normal" }}> (optional)</span>
                    )}
                  </Text>
                  {param.description && (
                    <Text size="1" color="gray">
                      {param.description}
                    </Text>
                  )}
                  {param.type === "string" && (
                    <TextField.Root
                      size="1"
                      placeholder={placeholderText}
                      value={String(agent.config[param.key] ?? "")}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => onUpdateConfig(param.key, e.target.value)}
                    />
                  )}
                  {param.type === "number" && (
                    <TextField.Root
                      size="1"
                      type="number"
                      placeholder={placeholderText}
                      value={String(agent.config[param.key] ?? "")}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        onUpdateConfig(param.key, e.target.value === "" ? "" : Number(e.target.value))
                      }
                    />
                  )}
                  {param.type === "boolean" && (
                    <Checkbox
                      checked={Boolean(agent.config[param.key])}
                      onClick={(e) => e.stopPropagation()}
                      onCheckedChange={(checked) => onUpdateConfig(param.key, Boolean(checked))}
                    />
                  )}
                  {param.type === "select" && param.options && (
                    <Select.Root
                      size="1"
                      value={String(agent.config[param.key] ?? "")}
                      onValueChange={(value) => onUpdateConfig(param.key, value)}
                    >
                      <Select.Trigger placeholder="Select..." onClick={(e) => e.stopPropagation()} />
                      <Select.Content>
                        {param.options.map((option) => (
                          <Select.Item key={option.value} value={option.value}>
                            {option.label}
                          </Select.Item>
                        ))}
                      </Select.Content>
                    </Select.Root>
                  )}
                </Flex>
              );
            })}
          </Flex>
        )}
      </Flex>
    </Card>
  );
}
