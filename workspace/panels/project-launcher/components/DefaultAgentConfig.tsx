/**
 * Default agent selection for the project.
 * Reuses agent selection patterns from chat-launcher.
 */

import { useState, useEffect, useCallback } from "react";
import { Box, Text, Card, Flex, RadioGroup, Badge } from "@radix-ui/themes";
import { PersonIcon } from "@radix-ui/react-icons";
import { getAgentRegistry, type AgentDefinition } from "@natstack/agentic-messaging/registry";

interface DefaultAgentConfigProps {
  defaultAgentId?: string;
  onDefaultAgentChange: (agentId: string | undefined) => void;
}

export function DefaultAgentConfig({
  defaultAgentId,
  onDefaultAgentChange,
}: DefaultAgentConfigProps) {
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function loadAgents() {
      try {
        const registry = getAgentRegistry();
        await registry.initialize();
        const enabledAgents = await registry.listEnabled();
        setAgents(enabledAgents);
        // Auto-select first agent if none selected and agents available
        if (!defaultAgentId && enabledAgents.length > 0) {
          onDefaultAgentChange(enabledAgents[0].id);
        }
      } catch (err) {
        console.error("Failed to load agents:", err);
      } finally {
        setLoading(false);
      }
    }
    void loadAgents();
  }, []);  // eslint-disable-line react-hooks/exhaustive-deps -- only run on mount

  const handleAgentChange = useCallback(
    (value: string) => {
      onDefaultAgentChange(value === "none" ? undefined : value);
    },
    [onDefaultAgentChange]
  );

  if (loading) {
    return (
      <Box>
        <Text size="2" color="gray">
          Loading agents...
        </Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text as="label" size="2" weight="medium" mb="2" style={{ display: "block" }}>
        Default Agent
      </Text>

      <RadioGroup.Root value={defaultAgentId ?? "none"} onValueChange={handleAgentChange}>
        <Flex direction="column" gap="2">
          {agents.length === 0 && (
            <Card size="1" asChild>
              <label style={{ cursor: "pointer" }}>
                <Flex align="center" gap="2">
                  <RadioGroup.Item value="none" />
                  <Text size="2" color="gray">
                    No default agent
                  </Text>
                </Flex>
              </label>
            </Card>
          )}

          {agents.map((agent) => (
            <Card key={agent.id} size="1" asChild>
              <label style={{ cursor: "pointer" }}>
                <Flex align="center" gap="2">
                  <RadioGroup.Item value={agent.id} />
                  <PersonIcon />
                  <Text size="2" weight="medium">
                    {agent.name}
                  </Text>
                  {agent.description && (
                    <Text size="1" color="gray">
                      {agent.description}
                    </Text>
                  )}
                  {defaultAgentId === agent.id && (
                    <Badge size="1" color="green">
                      Default
                    </Badge>
                  )}
                </Flex>
              </label>
            </Card>
          ))}
        </Flex>
      </RadioGroup.Root>

      <Text size="1" color="gray" mt="2">
        {agents.length > 0
          ? "This agent will be automatically spawned when launching new chat sessions"
          : "No agents available"}
      </Text>
    </Box>
  );
}
