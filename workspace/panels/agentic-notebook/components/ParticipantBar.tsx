import { useAtomValue } from "jotai";
import {
  Box,
  Flex,
  Badge,
  Popover,
  Text,
  Select,
  Button,
  Separator,
} from "@radix-ui/themes";
import { useParticipants, useChannelStatus } from "../hooks/useChannel";
import { useModelRole } from "../hooks/useAgent";
import { useKernelExecutionCount } from "../hooks/useKernel";
import { ThemeToggle } from "./ThemeToggle";
import type { AnyParticipant, ChannelStatus } from "../types/channel";

interface ParticipantBarProps {
  onToggleSidebar: () => void;
}

/**
 * Get color for participant type.
 */
function getParticipantColor(type: AnyParticipant["type"]): "gray" | "blue" | "green" | "orange" {
  switch (type) {
    case "user":
      return "blue";
    case "agent":
      return "green";
    case "kernel":
      return "orange";
    default:
      return "gray";
  }
}

/**
 * Check if a participant is currently active.
 */
function isParticipantActive(participant: AnyParticipant, status: ChannelStatus): boolean {
  switch (status) {
    case "user_typing":
      return participant.type === "user";
    case "agent_thinking":
    case "agent_streaming":
      return participant.type === "agent";
    case "kernel_executing":
      return participant.type === "kernel";
    default:
      return false;
  }
}

/**
 * Get status indicator text.
 */
function getStatusText(status: ChannelStatus): string {
  switch (status) {
    case "user_typing":
      return "Typing...";
    case "agent_thinking":
      return "Thinking...";
    case "agent_streaming":
      return "Responding...";
    case "kernel_executing":
      return "Executing...";
    case "error":
      return "Error";
    default:
      return "";
  }
}

/**
 * Participant configuration popover content.
 */
function ParticipantConfig({ participant }: { participant: AnyParticipant }) {
  const [modelRole, setModelRole] = useModelRole();
  const executionCount = useKernelExecutionCount();

  if (participant.type === "agent") {
    return (
      <Box style={{ minWidth: 200 }}>
        <Text size="2" weight="medium" mb="2">
          Agent Configuration
        </Text>
        <Separator size="4" mb="2" />
        <Flex direction="column" gap="2">
          <Box>
            <Text size="1" color="gray">
              Model Role
            </Text>
            <Select.Root value={modelRole} onValueChange={setModelRole}>
              <Select.Trigger style={{ width: "100%" }} />
              <Select.Content>
                <Select.Item value="fast">Fast</Select.Item>
                <Select.Item value="smart">Smart</Select.Item>
                <Select.Item value="coding">Coding</Select.Item>
                <Select.Item value="cheap">Cheap</Select.Item>
              </Select.Content>
            </Select.Root>
          </Box>
        </Flex>
      </Box>
    );
  }

  if (participant.type === "kernel") {
    return (
      <Box style={{ minWidth: 200 }}>
        <Text size="2" weight="medium" mb="2">
          Kernel Info
        </Text>
        <Separator size="4" mb="2" />
        <Flex direction="column" gap="1">
          <Flex justify="between">
            <Text size="1" color="gray">
              Executions
            </Text>
            <Text size="1">{executionCount}</Text>
          </Flex>
          <Flex justify="between">
            <Text size="1" color="gray">
              Status
            </Text>
            <Text size="1" color="green">
              Ready
            </Text>
          </Flex>
        </Flex>
      </Box>
    );
  }

  if (participant.type === "user") {
    return (
      <Box style={{ minWidth: 200 }}>
        <Text size="2" weight="medium" mb="2">
          User Settings
        </Text>
        <Separator size="4" mb="2" />
        <Text size="1" color="gray">
          Submit key: Enter
        </Text>
      </Box>
    );
  }

  return null;
}

/**
 * ParticipantBar - Shows participants and status at top of conversation.
 */
export function ParticipantBar({ onToggleSidebar }: ParticipantBarProps) {
  const participants = useParticipants();
  const status = useChannelStatus();
  const statusText = getStatusText(status);

  // Filter out system participant from display
  const visibleParticipants = participants.filter((p) => p.type !== "system");

  return (
    <Flex
      align="center"
      justify="between"
      px="3"
      py="2"
      style={{
        borderBottom: "1px solid var(--gray-a5)",
        background: "var(--gray-1)",
        flexShrink: 0,
      }}
    >
      <Flex align="center" gap="2">
        {/* Hamburger menu */}
        <Button
          variant="ghost"
          size="1"
          onClick={onToggleSidebar}
          style={{ padding: "4px 8px" }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="currentColor"
          >
            <rect x="2" y="3" width="12" height="1.5" rx="0.5" />
            <rect x="2" y="7" width="12" height="1.5" rx="0.5" />
            <rect x="2" y="11" width="12" height="1.5" rx="0.5" />
          </svg>
        </Button>

        {/* Participants */}
        {visibleParticipants.map((participant) => (
          <Popover.Root key={participant.id}>
            <Popover.Trigger>
              <Badge
                color={getParticipantColor(participant.type)}
                variant={isParticipantActive(participant, status) ? "solid" : "soft"}
                size="1"
                style={{ cursor: "pointer" }}
              >
                {participant.displayName}
              </Badge>
            </Popover.Trigger>
            <Popover.Content size="1">
              <ParticipantConfig participant={participant} />
            </Popover.Content>
          </Popover.Root>
        ))}
      </Flex>

      {/* Right side: status and theme toggle */}
      <Flex align="center" gap="2">
        {statusText && (
          <Text size="1" color="gray">
            {statusText}
          </Text>
        )}
        <ThemeToggle />
      </Flex>
    </Flex>
  );
}
