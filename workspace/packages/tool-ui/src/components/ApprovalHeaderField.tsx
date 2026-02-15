/**
 * ApprovalHeaderField Component
 *
 * Renders the header for tool approval prompts.
 * Handles both first-time agent grants and per-call approvals.
 *
 * First-time grant: Blue card with lock icon, approval level explanation
 * Per-call: Orange warning with "@agent wants to use Tool" message
 */

import { Box, Card, Code, Flex, Text } from "@radix-ui/themes";
import { LockClosedIcon, ExclamationTriangleIcon, CheckCircledIcon } from "@radix-ui/react-icons";
import { APPROVAL_LEVELS } from "../hooks/useToolApproval";

export interface ApprovalHeaderFieldProps {
  agentName: string;
  toolName: string;
  displayName?: string;
  isFirstTimeGrant: boolean;
  floorLevel: number;
}

export function ApprovalHeaderField({
  agentName,
  toolName,
  displayName,
  isFirstTimeGrant,
  floorLevel,
}: ApprovalHeaderFieldProps) {
  const toolDisplayName = displayName ?? toolName;

  // First-time grant header
  if (isFirstTimeGrant) {
    return (
      <Card style={{ borderLeft: "4px solid var(--blue-9)" }}>
        <Flex direction="column" gap="3" p="3">
          {/* Header */}
          <Flex gap="2" align="center">
            <LockClosedIcon style={{ color: "var(--blue-9)" }} />
            <Text size="3" weight="bold">
              New Agent Tool Access
            </Text>
          </Flex>

          {/* Description */}
          <Box>
            <Text size="2">
              <Text weight="bold">@{agentName}</Text> wants to access workspace tools.
            </Text>
          </Box>

          {/* Floor level explanation */}
          <Box style={{ background: "var(--gray-3)", borderRadius: 6, padding: 12 }}>
            <Text size="2" color="gray" style={{ display: "block", marginBottom: 8 }}>
              Based on current permission level ({APPROVAL_LEVELS[floorLevel as keyof typeof APPROVAL_LEVELS]?.label ?? "Unknown"}), this agent will:
            </Text>
            <Flex direction="column" gap="1">
              {APPROVAL_LEVELS[floorLevel as keyof typeof APPROVAL_LEVELS]?.details.map((desc, i) => (
                <Text key={i} size="2">
                  • {desc}
                </Text>
              ))}
            </Flex>
          </Box>

          {/* First tool call preview */}
          <Box>
            <Text size="2" color="gray" style={{ display: "block", marginBottom: 4 }}>
              First tool call: <Code>{toolDisplayName}</Code>
            </Text>
          </Box>
        </Flex>
      </Card>
    );
  }

  // Per-call approval header - special handling for plan mode
  const isExitPlanApproval = toolName === "exit_plan_mode";
  const isEnterPlanApproval = toolName === "enter_plan_mode";

  if (isEnterPlanApproval) {
    return (
      <Flex gap="2" align="center" mb="3">
        <ExclamationTriangleIcon style={{ color: "var(--blue-9)" }} />
        <Text size="3" weight="bold">
          @{agentName} wants to enter planning mode
        </Text>
      </Flex>
    );
  }

  if (isExitPlanApproval) {
    return (
      <Flex gap="2" align="center" mb="3">
        <CheckCircledIcon style={{ color: "var(--green-9)" }} />
        <Text size="3" weight="bold">
          @{agentName} is ready to implement
        </Text>
      </Flex>
    );
  }

  return (
    <Flex gap="2" align="center" mb="3">
      <ExclamationTriangleIcon style={{ color: "var(--orange-9)" }} />
      <Text size="3" weight="bold">
        @{agentName} wants to use <Code>{toolDisplayName}</Code>
      </Text>
    </Flex>
  );
}
