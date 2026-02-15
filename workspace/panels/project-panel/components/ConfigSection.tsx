/**
 * Collapsible configuration section.
 */

import { useState } from "react";
import { Box, Text, Card, Flex, Button, TextField, Separator } from "@radix-ui/themes";
import { ChevronDownIcon, ChevronRightIcon, GearIcon } from "@radix-ui/react-icons";
import { AgentSelector, type AgentInfo } from "@workspace/agentic-components";
import type { ProjectConfig } from "../types";
import { AUTONOMY_NOTCHES } from "@workspace/agentic-messaging/config";

interface ConfigSectionProps {
  config: ProjectConfig;
  agents: AgentInfo[];
  agentsLoading?: boolean;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (updates: Partial<ProjectConfig>) => void;
}

export function ConfigSection({ config, agents, agentsLoading, expanded, onToggle, onUpdate }: ConfigSectionProps) {
  const [editName, setEditName] = useState(config.name);

  const handleSaveName = () => {
    if (editName.trim() && editName !== config.name) {
      onUpdate({ name: editName.trim() });
    }
  };

  return (
    <Card size="1">
      <Flex
        align="center"
        gap="2"
        tabIndex={0}
        style={{ cursor: "pointer" }}
        onClick={onToggle}
      >
        {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <GearIcon />
        <Text size="2" weight="medium">
          Configuration
        </Text>
      </Flex>

      {expanded && (
        <Box mt="3">
          <Separator size="4" mb="3" />

          <Flex direction="column" gap="3">
            {/* Project Name */}
            <Box>
              <Text as="label" size="1" color="gray" mb="1" style={{ display: "block" }}>
                Project Name
              </Text>
              <Flex gap="2">
                <TextField.Root
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                  style={{ flex: 1 }}
                />
                <Button
                  variant="soft"
                  size="1"
                  onClick={handleSaveName}
                  disabled={editName === config.name}
                >
                  Save
                </Button>
              </Flex>
            </Box>

            {/* Location Info (read-only) */}
            <Box>
              <Text as="label" size="1" color="gray" mb="1" style={{ display: "block" }}>
                Location
              </Text>
              <Text size="2">
                {config.projectLocation === "managed"
                  ? `Managed (${config.includedRepos?.length ?? 0} repos)`
                  : config.workingDirectory ?? "Not set"}
              </Text>
            </Box>

            {/* Default Agent */}
            <Box>
              <AgentSelector
                agents={agents}
                loading={agentsLoading}
                defaultAgentId={config.defaultAgentId}
                onDefaultAgentChange={(agentId: string | undefined) => {
                  void onUpdate({ defaultAgentId: agentId });
                }}
              />
            </Box>

            {/* Autonomy Level */}
            <Box>
              <Text as="label" size="1" color="gray" mb="1" style={{ display: "block" }}>
                Autonomy Level
              </Text>
              <Text size="2">
                {AUTONOMY_NOTCHES.find((n) => n.value === config.defaultAutonomy)?.label ?? "Unknown"}
              </Text>
            </Box>
          </Flex>
        </Box>
      )}
    </Card>
  );
}
