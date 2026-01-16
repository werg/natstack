/**
 * Single diagnostic entry in the diagnostics panel.
 */

import { Flex, Text, Box } from "@radix-ui/themes";
import {
  CrossCircledIcon,
  ExclamationTriangleIcon,
  InfoCircledIcon,
} from "@radix-ui/react-icons";
import type { Diagnostic } from "../types";

export interface DiagnosticItemProps {
  diagnostic: Diagnostic;
  onClick: () => void;
}

/**
 * Get icon and color for diagnostic severity.
 */
function getSeverityStyles(severity: Diagnostic["severity"]) {
  switch (severity) {
    case "error":
      return {
        icon: <CrossCircledIcon />,
        color: "var(--red-9)",
      };
    case "warning":
      return {
        icon: <ExclamationTriangleIcon />,
        color: "var(--yellow-9)",
      };
    case "info":
    default:
      return {
        icon: <InfoCircledIcon />,
        color: "var(--blue-9)",
      };
  }
}

/**
 * Extract file name from full path.
 */
function getFileName(filePath: string): string {
  const parts = filePath.split("/");
  return parts[parts.length - 1] || filePath;
}

export function DiagnosticItem({ diagnostic, onClick }: DiagnosticItemProps) {
  const { icon, color } = getSeverityStyles(diagnostic.severity);

  return (
    <Flex
      align="start"
      gap="2"
      onClick={onClick}
      style={{
        padding: "6px 12px",
        cursor: "pointer",
        userSelect: "none",
        borderBottom: "1px solid var(--gray-4)",
      }}
      className="diagnostic-item"
    >
      {/* Severity icon */}
      <Box style={{ color, flexShrink: 0, marginTop: 2 }}>{icon}</Box>

      {/* Message and location */}
      <Flex direction="column" gap="0" style={{ flex: 1, minWidth: 0 }}>
        <Text
          size="1"
          style={{
            wordBreak: "break-word",
          }}
        >
          {diagnostic.message}
        </Text>
        <Text size="1" color="gray">
          {getFileName(diagnostic.file)}:{diagnostic.line}:{diagnostic.column}
        </Text>
      </Flex>
    </Flex>
  );
}
