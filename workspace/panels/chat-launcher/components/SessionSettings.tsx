/**
 * Session Settings Component
 *
 * Sets channel-level configuration (workingDirectory, restrictedMode via projectLocation)
 * and session defaults (defaultAutonomy).
 */

import { Card, Flex, Text } from "@radix-ui/themes";
import { ParameterEditor } from "@workspace/react";
import type { FieldValue } from "@natstack/types";
import { SESSION_PARAMETERS } from "@workspace/agentic-messaging/config";
import type { SessionConfig } from "../hooks/useAgentSelection";

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
          parameters={SESSION_PARAMETERS}
          values={config as unknown as Record<string, FieldValue>}
          onChange={(key, value) => onChange({ ...config, [key]: value } as SessionConfig)}
          size="1"
          showGroups={false}
        />
      </Flex>
    </Card>
  );
}
