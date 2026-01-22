/**
 * Session Settings Component
 *
 * Sets channel-level configuration (workingDirectory, restrictedMode via projectLocation)
 * and session defaults (defaultAutonomy).
 */

import { Card, Flex, Text } from "@radix-ui/themes";
import { ParameterEditor } from "@natstack/react";
import type { FieldDefinition } from "@natstack/runtime";
import type { SessionConfig } from "../hooks/useAgentSelection";

/** Field definitions for session settings */
const SESSION_FIELDS: FieldDefinition[] = [
  {
    key: "projectLocation",
    label: "Project Location",
    description: "Where the project files are stored",
    type: "segmented",
    options: [
      { value: "external", label: "External Filesystem", description: "Access files on your local machine" },
      { value: "browser", label: "Browser Storage", description: "Sandboxed browser storage (restricted mode)" },
    ],
  },
  {
    key: "workingDirectory",
    label: "Working Directory",
    description: "Path to the project directory",
    type: "string",
    placeholder: "/path/to/project",
    visibleWhen: { field: "projectLocation", operator: "eq", value: "external" },
  },
  {
    key: "defaultAutonomy",
    label: "Default Autonomy",
    description: "Default autonomy level for agents (can be overridden per-agent)",
    type: "slider",
    default: 0,
    min: 0,
    max: 2,
    step: 1,
    notches: [
      { value: 0, label: "Restricted", description: "Read-only access, requires approval" },
      { value: 1, label: "Standard", description: "Can modify workspace" },
      { value: 2, label: "Autonomous", description: "Full access, minimal restrictions" },
    ],
    warnings: [{ when: 2, message: "Allows unrestricted tool execution", severity: "danger" }],
  },
];

interface SessionSettingsProps {
  config: SessionConfig;
  onChange: (config: SessionConfig) => void;
}

export function SessionSettings({ config, onChange }: SessionSettingsProps) {
  return (
    <Card variant="surface">
      <Flex direction="column" gap="3" p="3">
        <Flex direction="column" gap="1">
          <Text size="3" weight="bold">
            Session Settings
          </Text>
          <Text size="1" color="gray">
            These apply to all agents in this conversation.
          </Text>
        </Flex>

        <ParameterEditor
          parameters={SESSION_FIELDS}
          values={config as Record<string, unknown>}
          onChange={(key, value) => onChange({ ...config, [key]: value })}
          size="1"
          showGroups={false}
        />
      </Flex>
    </Card>
  );
}
