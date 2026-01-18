import { useState, useMemo } from "react";
import { Badge, Box, Code, Flex, Text } from "@radix-ui/themes";
import { ExpandableChevron } from "./shared/Chevron";

export type MethodCallStatus = "pending" | "success" | "error";

export interface MethodHistoryEntry {
  callId: string;
  methodName: string;
  args: unknown;
  status: MethodCallStatus;
  consoleOutput?: string;
  result?: unknown;
  error?: string;
  startedAt: number;
  completedAt?: number;
  providerId?: string;
  callerId?: string;
  handledLocally?: boolean;
  progress?: number;
}

const METHOD_STATUS_COLOR: Record<MethodCallStatus, "gray" | "green" | "red"> = {
  pending: "gray",
  success: "green",
  error: "red",
};

const STATUS_DOT_COLOR: Record<MethodCallStatus, string> = {
  pending: "var(--gray-8)",
  success: "var(--green-9)",
  error: "var(--red-9)",
};

function formatMethodMeta(entry: MethodHistoryEntry): { label: string; value: string }[] {
  const items: { label: string; value: string }[] = [];
  if (entry.callerId) items.push({ label: "caller", value: entry.callerId });
  if (entry.handledLocally !== undefined) {
    items.push({ label: "handledLocally", value: entry.handledLocally ? "yes" : "no" });
  }
  return items;
}

// Collapsible section component
function CollapsibleSection({
  label,
  defaultOpen = false,
  children,
  color = "gray",
}: {
  label: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  color?: "gray" | "red" | "green" | "blue";
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <Box>
      <Flex
        align="center"
        gap="1"
        onClick={() => setIsOpen(!isOpen)}
        style={{ cursor: "pointer", userSelect: "none" }}
      >
        <Text size="1" color={color}>
          <ExpandableChevron expanded={isOpen} />
        </Text>
        <Text size="1" color={color} weight="medium">
          {label}
        </Text>
      </Flex>
      {isOpen && (
        <Box mt="1" ml="3">
          {children}
        </Box>
      )}
    </Box>
  );
}

// JSON Tree Explorer using Radix UI primitives
function JsonValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [isExpanded, setIsExpanded] = useState(depth < 2);

  // Primitives
  if (value === null) {
    return <Text size="1" color="gray">null</Text>;
  }

  if (value === undefined) {
    return <Text size="1" color="gray">undefined</Text>;
  }

  if (typeof value === "boolean") {
    return <Text size="1" color="purple">{String(value)}</Text>;
  }

  if (typeof value === "number") {
    return <Text size="1" color="orange">{String(value)}</Text>;
  }

  if (typeof value === "string") {
    // Check if it's a long/multiline string (like code)
    if (value.includes("\n") || value.length > 100) {
      return (
        <Box>
          <Flex
            align="center"
            gap="1"
            onClick={() => setIsExpanded(!isExpanded)}
            style={{ cursor: "pointer", userSelect: "none" }}
          >
            <ExpandableChevron expanded={isExpanded} />
            <Text size="1" color="gray">{value.length} chars</Text>
          </Flex>
          {isExpanded && (
            <Box mt="1" ml="3">
              <Code
                size="1"
                style={{
                  display: "block",
                  whiteSpace: "pre-wrap",
                  padding: "8px",
                  maxHeight: "300px",
                  overflow: "auto",
                  backgroundColor: "var(--gray-a3)",
                }}
              >
                {value}
              </Code>
            </Box>
          )}
        </Box>
      );
    }
    return <Text size="1" color="green">{value}</Text>;
  }

  // Arrays
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <Text size="1" color="gray">[]</Text>;
    }

    return (
      <Box>
        <Flex
          align="center"
          gap="1"
          onClick={() => setIsExpanded(!isExpanded)}
          style={{ cursor: "pointer", userSelect: "none" }}
        >
          <ExpandableChevron expanded={isExpanded} />
          <Text size="1" color="gray">[{value.length}]</Text>
        </Flex>
        {isExpanded && (
          <Box mt="1" ml="3">
            {value.map((item, index) => (
              <Box key={index} py="1">
                <Text size="1" color="gray">{index}</Text>
                <Box ml="3">
                  <JsonValue value={item} depth={depth + 1} />
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  // Objects
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) {
      return <Text size="1" color="gray">{"{}"}</Text>;
    }

    return (
      <Box>
        <Flex
          align="center"
          gap="1"
          onClick={() => setIsExpanded(!isExpanded)}
          style={{ cursor: "pointer", userSelect: "none" }}
        >
          <ExpandableChevron expanded={isExpanded} />
          <Text size="1" color="gray">{"{"}...{"}"}</Text>
        </Flex>
        {isExpanded && (
          <Box mt="1" ml="3">
            {entries.map(([key, val]) => (
              <Box key={key} py="1">
                <Text size="1" color="cyan">{key}</Text>
                <Box ml="3">
                  <JsonValue value={val} depth={depth + 1} />
                </Box>
              </Box>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  return <Text size="1">{String(value)}</Text>;
}

// Plain text display for console output
function PlainTextDisplay({ content }: { content: string }) {
  return (
    <Code
      size="1"
      style={{
        display: "block",
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        padding: "8px",
        maxHeight: "300px",
        overflow: "auto",
        backgroundColor: "var(--gray-a3)",
      }}
    >
      {content}
    </Code>
  );
}

// Export sub-components for use in InlineGroup
export { CompactMethodPill, ExpandedMethodDetail };

// Compact inline pill for collapsed method calls
function CompactMethodPill({
  entry,
  onClick
}: {
  entry: MethodHistoryEntry;
  onClick: () => void;
}) {
  return (
    <Flex
      align="center"
      gap="1"
      onClick={onClick}
      style={{
        cursor: "pointer",
        userSelect: "none",
        padding: "2px 6px",
        borderRadius: "4px",
        backgroundColor: "var(--gray-a3)",
        display: "inline-flex",
      }}
    >
      <Box
        style={{
          width: 6,
          height: 6,
          borderRadius: "50%",
          backgroundColor: STATUS_DOT_COLOR[entry.status],
          flexShrink: 0,
        }}
      />
      <Text size="1" color="gray" style={{ fontFamily: "var(--code-font-family)" }}>
        {entry.methodName}
      </Text>
    </Flex>
  );
}

// Expanded detail view for a single method call (used within group)
function ExpandedMethodDetail({
  entry,
  onCollapse
}: {
  entry: MethodHistoryEntry;
  onCollapse: () => void;
}) {
  const metaItems = useMemo(() => formatMethodMeta(entry), [entry]);

  return (
    <Box
      style={{
        backgroundColor: "var(--gray-a2)",
        borderRadius: "6px",
        padding: "8px 10px",
        border: "1px solid var(--gray-a4)",
      }}
    >
      {/* Header */}
      <Flex
        align="center"
        gap="2"
        onClick={onCollapse}
        style={{ cursor: "pointer", userSelect: "none" }}
      >
        <Text color="gray" style={{ display: "flex", alignItems: "center" }}>
          <ExpandableChevron expanded={true} />
        </Text>
        <Box
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            backgroundColor: STATUS_DOT_COLOR[entry.status],
            flexShrink: 0,
          }}
        />
        <Text size="1" weight="medium" style={{ fontFamily: "var(--code-font-family)" }}>
          {entry.methodName}
        </Text>
        <Badge color={METHOD_STATUS_COLOR[entry.status]} size="1" variant="soft">
          {entry.status}
        </Badge>
      </Flex>

      {/* Content */}
      <Flex direction="column" gap="2" mt="2" ml="4">
        {/* Meta badges */}
        {metaItems.length > 0 && (
          <Flex gap="1" wrap="wrap">
            {metaItems.map((item) => (
              <Badge key={item.label} color="gray" variant="soft" size="1">
                {item.label}: {item.value}
              </Badge>
            ))}
          </Flex>
        )}

        {/* Args */}
        <CollapsibleSection label="Args" defaultOpen={false}>
          <Box
            style={{
              backgroundColor: "var(--gray-a2)",
              borderRadius: "4px",
              padding: "6px",
              maxHeight: "300px",
              overflow: "auto",
            }}
          >
            <JsonValue value={entry.args} />
          </Box>
        </CollapsibleSection>

        {/* Console */}
        {entry.consoleOutput && (
          <CollapsibleSection label="Console" defaultOpen={true}>
            <PlainTextDisplay content={entry.consoleOutput} />
          </CollapsibleSection>
        )}

        {/* Result */}
        {entry.status === "success" && entry.result !== undefined && (
          <CollapsibleSection label="Result" defaultOpen={true} color="green">
            <Box
              style={{
                backgroundColor: "var(--gray-a2)",
                borderRadius: "4px",
                padding: "6px",
                maxHeight: "300px",
                overflow: "auto",
              }}
            >
              <JsonValue value={entry.result} />
            </Box>
          </CollapsibleSection>
        )}

        {/* Error */}
        {entry.status === "error" && entry.error && (
          <Box
            style={{
              padding: "6px",
              backgroundColor: "var(--red-a3)",
              borderRadius: "4px",
            }}
          >
            <Text size="1" color="red" style={{ whiteSpace: "pre-wrap" }}>
              {entry.error}
            </Text>
          </Box>
        )}
      </Flex>
    </Box>
  );
}

