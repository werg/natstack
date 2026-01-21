/**
 * Tool Role Conflict Modal
 *
 * Shows when multiple panels are providing the same tool groups.
 * Allows user to take over tools or defer to the existing provider.
 */

import { Box, Button, Card, Flex, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import type { PendingConflict } from "../hooks/useToolRole";

const GROUP_LABELS: Record<string, string> = {
  "file-ops": "File Operations",
  "git-ops": "Git Operations",
};

interface ToolRoleConflictModalProps {
  conflict: PendingConflict;
  onTakeOver: () => void;
  onDefer: () => void;
  onDismiss: () => void;
  isNegotiating: boolean;
}

export function ToolRoleConflictModal({
  conflict,
  onTakeOver,
  onDefer,
  onDismiss,
  isNegotiating,
}: ToolRoleConflictModalProps) {
  const { group, conflict: conflictInfo } = conflict;
  const groupLabel = GROUP_LABELS[group] ?? group;

  // Find the current resolved provider
  const resolvedProvider = conflictInfo.providers.find(
    (p) => p.id === conflictInfo.resolvedProvider
  );

  return (
    <Card style={{ borderLeft: "4px solid var(--orange-9)" }}>
      <Flex direction="column" gap="3" p="3">
        {/* Header */}
        <Flex gap="2" align="center">
          <ExclamationTriangleIcon style={{ color: "var(--orange-9)" }} />
          <Text size="3" weight="bold">
            Tool Provider Conflict: {groupLabel}
          </Text>
        </Flex>

        {/* Description */}
        <Box>
          <Text size="2">
            Another panel ({resolvedProvider?.name ?? "unknown"}) is already providing{" "}
            <Text weight="bold">{groupLabel}</Text> tools.
          </Text>
        </Box>

        {/* Providers list */}
        <Box style={{ background: "var(--gray-3)", borderRadius: 6, padding: 12 }}>
          <Text size="2" color="gray" style={{ display: "block", marginBottom: 8 }}>
            Current providers:
          </Text>
          <Flex direction="column" gap="1">
            {conflictInfo.providers.map((provider) => (
              <Text key={provider.id} size="2">
                {provider.id === conflictInfo.resolvedProvider ? "✓ " : "  "}
                {provider.name}
                {provider.id === conflictInfo.resolvedProvider && (
                  <Text color="gray"> (active)</Text>
                )}
              </Text>
            ))}
          </Flex>
        </Box>

        {/* Actions */}
        <Flex gap="2" justify="end">
          <Button variant="ghost" color="gray" onClick={onDismiss}>
            Dismiss
          </Button>
          <Button variant="soft" color="gray" onClick={onDefer}>
            Use Existing
          </Button>
          <Button
            variant="solid"
            onClick={onTakeOver}
            disabled={isNegotiating}
          >
            {isNegotiating ? "Requesting..." : "Take Over"}
          </Button>
        </Flex>
      </Flex>
    </Card>
  );
}
