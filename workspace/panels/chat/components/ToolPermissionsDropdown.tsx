/**
 * Tool Permissions Dropdown
 *
 * Header dropdown for configuring global tool approval settings.
 * Shows floor level selection and per-agent grant status.
 */

import { Badge, Button, DropdownMenu, Flex, Text } from "@radix-ui/themes";
import { LockClosedIcon, CheckIcon } from "@radix-ui/react-icons";
import type { Participant } from "@natstack/pubsub";
import { APPROVAL_LEVELS, type ToolApprovalSettings, type ApprovalLevel } from "@natstack/tool-ui";
import type { ChatParticipantMetadata } from "../types";

interface ToolPermissionsDropdownProps {
  settings: ToolApprovalSettings;
  participants: Record<string, Participant<ChatParticipantMetadata>>;
  onSetFloor: (level: ApprovalLevel) => void;
  onGrantAgent: (agentId: string) => void;
  onRevokeAgent: (agentId: string) => void;
  onRevokeAll: () => void;
}

export function ToolPermissionsDropdown({
  settings,
  participants,
  onSetFloor,
  onGrantAgent,
  onRevokeAgent,
  onRevokeAll,
}: ToolPermissionsDropdownProps) {
  // Filter to only show agents (not panel or other participant types)
  const agents = Object.values(participants).filter(
    (p) => p.metadata.type !== "panel"
  );

  const grantedCount = Object.keys(settings.agentGrants).length;

  // Determine icon color based on floor level
  const iconColor = settings.globalFloor === 2 ? "orange" : settings.globalFloor === 1 ? "green" : "blue";

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger>
        <Button variant="soft" size="1" color={iconColor}>
          <LockClosedIcon />
          <Text size="1">{APPROVAL_LEVELS[settings.globalFloor as keyof typeof APPROVAL_LEVELS]?.label}</Text>
        </Button>
      </DropdownMenu.Trigger>

      <DropdownMenu.Content style={{ minWidth: 220 }}>
        {/* Global Floor Section */}
        <DropdownMenu.Label>Tool Permission Level</DropdownMenu.Label>

        {([0, 1, 2] as const).map((level) => (
          <DropdownMenu.CheckboxItem
            key={level}
            checked={settings.globalFloor === level}
            onCheckedChange={() => onSetFloor(level)}
          >
            <Flex direction="column" gap="1">
              <Text size="2" weight={settings.globalFloor === level ? "bold" : "regular"}>
                {APPROVAL_LEVELS[level].label}
              </Text>
              <Text size="1" color="gray">
                {APPROVAL_LEVELS[level].shortDesc}
              </Text>
            </Flex>
          </DropdownMenu.CheckboxItem>
        ))}

        {/* Agents Section */}
        {agents.length > 0 && (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Label>Agent Access</DropdownMenu.Label>

            {agents.map((agent) => {
              const isGranted = agent.id in settings.agentGrants;
              return (
                <DropdownMenu.Item
                  key={agent.id}
                  onSelect={(e) => {
                    e.preventDefault();
                    if (isGranted) {
                      onRevokeAgent(agent.id);
                    } else {
                      onGrantAgent(agent.id);
                    }
                  }}
                >
                  <Flex justify="between" align="center" style={{ width: "100%" }}>
                    <Flex gap="2" align="center">
                      {isGranted && <CheckIcon />}
                      <Text size="2">@{agent.metadata.handle}</Text>
                    </Flex>
                    <Badge size="1" color={isGranted ? "green" : "gray"}>
                      {isGranted ? "granted" : "pending"}
                    </Badge>
                  </Flex>
                </DropdownMenu.Item>
              );
            })}
          </>
        )}

        {/* Revoke All */}
        {grantedCount > 0 && (
          <>
            <DropdownMenu.Separator />
            <DropdownMenu.Item
              color="red"
              onSelect={() => onRevokeAll()}
            >
              Revoke All Access ({grantedCount})
            </DropdownMenu.Item>
          </>
        )}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  );
}
