import { Box, Code, Flex, Spinner, Text } from "@radix-ui/themes";
import type { ActionData } from "@natstack/agentic-messaging";
import { prettifyToolName } from "@natstack/agentic-messaging";
import { ExpandableChevron } from "./shared/Chevron";

// Collapsed state - compact pill (blue background to distinguish from thinking)
export function ActionPill({
  data,
  onClick,
}: {
  data: ActionData;
  onClick: () => void;
}) {
  const isStreaming = data.status === "pending";

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
        backgroundColor: "var(--blue-a3)",
        display: "inline-flex",
      }}
    >
      {isStreaming && <Spinner size="1" />}
      <Text size="1" color="blue" weight="medium">
        {prettifyToolName(data.type)}
      </Text>
      <Text size="1" color="gray" style={{ opacity: 0.7 }}>
        {data.description}
      </Text>
    </Flex>
  );
}

// Expanded state - shows full action details
export function ExpandedAction({
  data,
  onCollapse,
}: {
  data: ActionData;
  onCollapse: () => void;
}) {
  return (
    <Box
      style={{
        backgroundColor: "var(--blue-a2)",
        borderRadius: "6px",
        padding: "8px 10px",
        border: "1px solid var(--blue-a4)",
      }}
    >
      <Flex
        align="center"
        gap="2"
        onClick={onCollapse}
        style={{ cursor: "pointer", userSelect: "none" }}
      >
        <Text color="blue" style={{ display: "flex", alignItems: "center" }}>
          <ExpandableChevron expanded={true} />
        </Text>
        <Text size="1" color="blue" weight="medium">
          {prettifyToolName(data.type)}
        </Text>
        <Text size="1" color="gray">
          {data.description}
        </Text>
      </Flex>
      {data.toolUseId && (
        <Box mt="2" ml="4">
          <Code size="1" color="gray">
            Tool Use ID: {data.toolUseId}
          </Code>
        </Box>
      )}
    </Box>
  );
}

/**
 * Parse action data from message content, with fallback for malformed content.
 * Handles edge cases like duplicated JSON objects from update() calls.
 */
export function parseActionData(content: string, complete?: boolean): ActionData {
  let data: ActionData;
  try {
    data = JSON.parse(content);
  } catch {
    // Try to extract the first valid JSON object if content has duplicates
    // (This can happen if completeAction() incorrectly appended content)
    const firstBrace = content.indexOf("{");
    const closingBrace = findMatchingBrace(content, firstBrace);
    if (firstBrace >= 0 && closingBrace > firstBrace) {
      try {
        data = JSON.parse(content.slice(firstBrace, closingBrace + 1));
      } catch {
        // Final fallback for truly malformed content
        data = { type: "Unknown", description: content.slice(0, 100), status: "pending" };
      }
    } else {
      // Fallback for malformed content
      data = { type: "Unknown", description: content.slice(0, 100), status: "pending" };
    }
  }

  // Override status based on message complete flag
  if (complete) {
    data = { ...data, status: "complete" };
  }

  return data;
}

/**
 * Find the position of the matching closing brace for an opening brace.
 */
function findMatchingBrace(str: string, openPos: number): number {
  if (str[openPos] !== "{") return -1;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = openPos; i < str.length; i++) {
    const char = str[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (char === "\\") {
      escape = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") depth++;
    if (char === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}
