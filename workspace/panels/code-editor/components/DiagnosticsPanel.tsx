/**
 * Bottom panel showing type check diagnostics.
 *
 * Displays errors and warnings grouped by file with navigation.
 */

import { useState } from "react";
import { Flex, Text, Box, IconButton, Badge } from "@radix-ui/themes";
import { ChevronUpIcon, ChevronDownIcon } from "@radix-ui/react-icons";
import type { Diagnostic } from "../types";
import { DiagnosticItem } from "./DiagnosticItem";

const DIAGNOSTICS_PANEL_STYLE = {
  MIN_HEIGHT_PX: 100,
  MAX_HEIGHT_PX: 200,
} as const;

export interface DiagnosticsPanelProps {
  diagnostics: Diagnostic[];
  errorCount: number;
  warningCount: number;
  onNavigate: (file: string, line: number, column: number) => void;
  style?: React.CSSProperties;
  initError?: string | null;
  isInitializing?: boolean;
}

export function DiagnosticsPanel({
  diagnostics,
  errorCount,
  warningCount,
  onNavigate,
  style,
  initError,
  isInitializing,
}: DiagnosticsPanelProps) {
  const [isCollapsed, setIsCollapsed] = useState(false);

  const hasProblems = diagnostics.length > 0;

  return (
    <Flex
      direction="column"
      style={{
        ...style,
        borderTop: "1px solid var(--gray-6)",
        backgroundColor: "var(--gray-2)",
      }}
    >
      {/* Header */}
      <Flex
        align="center"
        justify="between"
        onClick={() => setIsCollapsed(!isCollapsed)}
        style={{
          padding: "6px 12px",
          cursor: "pointer",
          userSelect: "none",
          borderBottom: isCollapsed ? "none" : "1px solid var(--gray-5)",
        }}
      >
        <Flex align="center" gap="2">
          <Text size="1" weight="medium">
            Problems
          </Text>
          {errorCount > 0 && (
            <Badge color="red" size="1">
              {errorCount}
            </Badge>
          )}
          {warningCount > 0 && (
            <Badge color="yellow" size="1">
              {warningCount}
            </Badge>
          )}
        </Flex>

        <IconButton size="1" variant="ghost" color="gray">
          {isCollapsed ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </IconButton>
      </Flex>

      {/* Content */}
      {!isCollapsed && (
        <Box
          style={{
            flex: 1,
            overflow: "auto",
            minHeight: DIAGNOSTICS_PANEL_STYLE.MIN_HEIGHT_PX,
            maxHeight: DIAGNOSTICS_PANEL_STYLE.MAX_HEIGHT_PX,
          }}
        >
          <style>
            {`
              .diagnostic-item:hover {
                background-color: var(--gray-a3);
              }
            `}
          </style>
          {initError && (
            <Box p="2" style={{ backgroundColor: "var(--red-3)", color: "var(--red-11)" }}>
              <Text size="2">Type checking failed: {initError}</Text>
            </Box>
          )}
          {isInitializing && !initError && (
            <Box p="2">
              <Text size="2" color="gray">Initializing type checker...</Text>
            </Box>
          )}
          {!initError && !isInitializing && !hasProblems ? (
            <Flex
              align="center"
              justify="center"
              style={{ height: "100%", padding: 16 }}
            >
              <Text size="1" color="gray">
                No problems detected
              </Text>
            </Flex>
          ) : (
            diagnostics.map((diagnostic, index) => (
              <DiagnosticItem
                key={`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${index}`}
                diagnostic={diagnostic}
                onClick={() =>
                  onNavigate(diagnostic.file, diagnostic.line, diagnostic.column)
                }
              />
            ))
          )}
        </Box>
      )}
    </Flex>
  );
}
