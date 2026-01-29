import { useState, useMemo } from "react";
import { Badge, Box, Code, Flex, Text } from "@radix-ui/themes";
import { ExpandableChevron } from "./shared/Chevron";
import { prettifyToolName } from "@natstack/agentic-messaging";

export type MethodCallStatus = "pending" | "success" | "error";

export interface MethodHistoryEntry {
  callId: string;
  methodName: string;
  /** Human-readable description of the method (from MethodAdvertisement) */
  description?: string;
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

/**
 * Create a pretty, human-readable summary of method arguments.
 * Shows key parameters in a concise format.
 */
function formatArgsSummary(args: unknown, maxLen = 60): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return truncateStr(String(args), maxLen);

  const obj = args as Record<string, unknown>;
  const entries = Object.entries(obj);
  if (entries.length === 0) return "";

  // Priority keys to show first (common parameter names)
  const priorityKeys = ["file_path", "path", "command", "query", "pattern", "url", "code", "content", "message", "name", "title"];

  // Sort entries: priority keys first, then others
  entries.sort((a, b) => {
    const aIdx = priorityKeys.indexOf(a[0]);
    const bIdx = priorityKeys.indexOf(b[0]);
    if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
    if (aIdx !== -1) return -1;
    if (bIdx !== -1) return 1;
    return 0;
  });

  const parts: string[] = [];
  let totalLen = 0;

  for (const [key, value] of entries) {
    const formattedValue = formatArgValue(value);
    if (!formattedValue) continue;

    const part = `${key}: ${formattedValue}`;
    if (totalLen + part.length > maxLen && parts.length > 0) {
      parts.push("...");
      break;
    }
    parts.push(part);
    totalLen += part.length + 2; // +2 for ", "
  }

  return parts.join(", ");
}

/**
 * Format a single argument value for display.
 */
function formatArgValue(value: unknown, maxLen = 30): string {
  if (value === null) return "null";
  if (value === undefined) return "";
  if (typeof value === "boolean") return String(value);
  if (typeof value === "number") return String(value);
  if (typeof value === "string") {
    // For file paths, show just the filename or truncated path
    if (value.includes("/")) {
      const parts = value.split("/");
      const filename = parts.pop() || "";
      if (filename.length <= maxLen) return filename;
      return "..." + filename.slice(-(maxLen - 3));
    }
    return truncateStr(value, maxLen);
  }
  if (Array.isArray(value)) {
    return `[${value.length} items]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as object);
    return `{${keys.length} fields}`;
  }
  return truncateStr(String(value), maxLen);
}

function truncateStr(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
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
        tabIndex={0}
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
            tabIndex={0}
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
          tabIndex={0}
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
          tabIndex={0}
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
  const argsSummary = useMemo(() => formatArgsSummary(entry.args, 50), [entry.args]);

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
        maxWidth: "100%",
      }}
      tabIndex={0}
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
      <Text size="1" color="gray" style={{ fontFamily: "var(--code-font-family)", flexShrink: 0 }}>
        {prettifyToolName(entry.methodName)}
      </Text>
      {argsSummary && (
        <Text
          size="1"
          color="gray"
          style={{
            opacity: 0.7,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          ({argsSummary})
        </Text>
      )}
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
  const argsSummary = useMemo(() => formatArgsSummary(entry.args, 80), [entry.args]);

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
        tabIndex={0}
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
          {prettifyToolName(entry.methodName)}
        </Text>
        <Badge color={METHOD_STATUS_COLOR[entry.status]} size="1" variant="soft">
          {entry.status}
        </Badge>
      </Flex>

      {/* Content */}
      <Flex direction="column" gap="2" mt="2" ml="4">
        {/* Description */}
        {entry.description && (
          <Text size="1" color="gray" style={{ fontStyle: "italic" }}>
            {entry.description}
          </Text>
        )}

        {/* Args summary - pretty display */}
        {argsSummary && (
          <Box
            style={{
              padding: "4px 8px",
              backgroundColor: "var(--gray-a3)",
              borderRadius: "4px",
              borderLeft: "2px solid var(--gray-a6)",
            }}
          >
            <Text size="1" style={{ fontFamily: "var(--code-font-family)" }}>
              {argsSummary}
            </Text>
          </Box>
        )}

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

