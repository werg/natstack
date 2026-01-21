import { Box, Code, Flex, Spinner, Text } from "@radix-ui/themes";
import { ExpandableChevron } from "./shared/Chevron";

// Collapsed state - small inline pill matching method calls
function ThinkingPill({
  preview,
  isTruncated,
  isStreaming,
  onClick,
}: {
  preview: string;
  isTruncated: boolean;
  isStreaming: boolean;
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
      {isStreaming && <Spinner size="1" />}
      <Text size="1" color="gray" weight="medium">
        Thinking
      </Text>
      {preview && (
        <Text size="1" color="gray" style={{ opacity: 0.7 }}>
          {preview}{isTruncated ? "..." : ""}
        </Text>
      )}
    </Flex>
  );
}

// Expanded state - shows full thinking content
function ExpandedThinking({
  content,
  onCollapse,
}: {
  content: string;
  onCollapse: () => void;
}) {
  return (
    <Box
      style={{
        backgroundColor: "var(--gray-a2)",
        borderRadius: "6px",
        padding: "8px 10px",
        border: "1px solid var(--gray-a4)",
      }}
    >
      <Flex
        align="center"
        gap="2"
        onClick={onCollapse}
        style={{ cursor: "pointer", userSelect: "none" }}
      >
        <Text color="gray" style={{ display: "flex", alignItems: "center" }}>
          <ExpandableChevron expanded={true} />
        </Text>
        <Text size="1" color="gray" weight="medium">
          Thinking
        </Text>
      </Flex>
      <Box mt="2" ml="4">
        <Code
          size="1"
          style={{
            whiteSpace: "pre-wrap",
            display: "block",
            maxHeight: "300px",
            overflow: "auto",
          }}
        >
          {content}
        </Code>
      </Box>
    </Box>
  );
}

export const PREVIEW_MAX_LENGTH = 50;

// Export sub-components for use in InlineGroup
export { ThinkingPill, ExpandedThinking };
