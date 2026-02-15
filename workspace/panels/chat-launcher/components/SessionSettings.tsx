/**
 * Session Settings Component
 *
 * Sets channel-level configuration (workingDirectory, restrictedMode via projectLocation)
 * and session defaults (defaultAutonomy).
 */

import { useState, useEffect } from "react";
import { Card, Flex, Text, Select } from "@radix-ui/themes";
import { ParameterEditor } from "@workspace/react";
import { rpc } from "@workspace/runtime";
import type { FieldValue } from "@natstack/types";
import { SESSION_PARAMETERS } from "@workspace/agentic-messaging/config";
import type { SessionConfig } from "../hooks/useAgentSelection";

/** Template info returned from the bridge */
interface AvailableTemplate {
  spec: string;
  name: string;
  description?: string;
}

interface SessionSettingsProps {
  config: SessionConfig;
  onChange: (config: SessionConfig) => void;
}

export function SessionSettings({ config, onChange }: SessionSettingsProps) {
  const [templates, setTemplates] = useState<AvailableTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(false);

  // Load templates when browser mode is selected
  useEffect(() => {
    if (config.projectLocation === "browser") {
      setTemplatesLoading(true);
      rpc.call<AvailableTemplate[]>("main", "bridge.listContextTemplates")
        .then((result) => {
          setTemplates(result);
          // Auto-select first template if none selected
          if (result.length > 0 && !config.contextTemplateSpec) {
            onChange({ ...config, contextTemplateSpec: result[0]!.spec });
          }
        })
        .catch((err) => {
          console.error("Failed to load context templates:", err);
          setTemplates([]);
        })
        .finally(() => setTemplatesLoading(false));
    }
  }, [config.projectLocation]);

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

        {config.projectLocation === "browser" && (
          <Flex direction="column" gap="1">
            <Text size="2" weight="medium">
              Context Template
            </Text>
            <Text size="1" color="gray">
              The sandboxed filesystem template for this session.
            </Text>
            <Select.Root
              value={config.contextTemplateSpec || ""}
              onValueChange={(spec) => onChange({ ...config, contextTemplateSpec: spec })}
              disabled={templatesLoading || templates.length === 0}
            >
              <Select.Trigger placeholder={templatesLoading ? "Loading..." : "Select a template..."} />
              <Select.Content>
                {templates.map((template) => (
                  <Select.Item key={template.spec} value={template.spec}>
                    {template.name}
                    {template.description && (
                      <Text size="1" color="gray"> - {template.description}</Text>
                    )}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
          </Flex>
        )}
      </Flex>
    </Card>
  );
}
