import { Badge, Box, Card, Code, Flex, Text } from "@radix-ui/themes";

export type ToolCallStatus = "pending" | "success" | "error";

export interface ToolHistoryEntry {
  callId: string;
  toolName: string;
  args: unknown;
  status: ToolCallStatus;
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

const TOOL_STATUS_COLOR: Record<ToolCallStatus, "gray" | "green" | "red"> = {
  pending: "gray",
  success: "green",
  error: "red",
};

function formatToolValue(value: unknown): string {
  const seen = new WeakSet();
  try {
    return JSON.stringify(
      value,
      (_key, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v as object)) return "[Circular]";
          seen.add(v as object);
        }
        return v;
      },
      2
    );
  } catch {
    return String(value);
  }
}

function summarizeToolArgs(args: unknown): string {
  if (typeof args === "object" && args !== null && "code" in (args as Record<string, unknown>)) {
    const code = (args as Record<string, unknown>)["code"];
    if (typeof code === "string") {
      const firstLine = code.split("\n")[0]?.trim() ?? "";
      const snippet = firstLine.slice(0, 80);
      return snippet.length < firstLine.length ? `${snippet}...` : snippet || "(empty code)";
    }
  }
  const formatted = formatToolValue(args);
  return formatted.length > 80 ? `${formatted.slice(0, 80)}...` : formatted;
}

function formatToolMeta(entry: ToolHistoryEntry): string {
  const lines: string[] = [];
  if (entry.callerId) lines.push(`caller: ${entry.callerId}`);
  if (entry.providerId) lines.push(`provider: ${entry.providerId}`);
  if (entry.progress !== undefined) lines.push(`progress: ${entry.progress}%`);
  if (entry.handledLocally !== undefined) {
    lines.push(`handledLocally: ${entry.handledLocally ? "yes" : "no"}`);
  }
  return lines.join("\n");
}

interface ToolHistoryItemProps {
  entry: ToolHistoryEntry;
}

export function ToolHistoryItem({ entry }: ToolHistoryItemProps) {
  const summary = summarizeToolArgs(entry.args);

  return (
    <Box style={{ maxWidth: "100%" }}>
      <Card variant="surface">
        <details>
          <summary style={{ cursor: "pointer", listStyle: "none" }}>
            <Flex align="center" gap="2">
              <Badge color={TOOL_STATUS_COLOR[entry.status]}>{entry.status}</Badge>
              <Text size="2" weight="medium">
                Tool: {entry.toolName}
              </Text>
              <Text size="1" color="gray">
                {summary}
              </Text>
            </Flex>
          </summary>
          <Flex direction="column" gap="2" mt="3">
            {(entry.callerId ||
              entry.providerId ||
              entry.progress !== undefined ||
              entry.handledLocally !== undefined) && (
              <Box>
                <Text size="1" color="gray">
                  Meta
                </Text>
                <Code size="1" style={{ display: "block", whiteSpace: "pre-wrap" }}>
                  {formatToolMeta(entry)}
                </Code>
              </Box>
            )}
            <Box>
              <Text size="1" color="gray">
                Args
              </Text>
              <Code size="1" style={{ display: "block", whiteSpace: "pre-wrap" }}>
                {formatToolValue(entry.args)}
              </Code>
            </Box>
            {entry.consoleOutput && (
              <Box>
                <Text size="1" color="gray">
                  Console
                </Text>
                <Code size="1" style={{ display: "block", whiteSpace: "pre-wrap" }}>
                  {entry.consoleOutput}
                </Code>
              </Box>
            )}
            {entry.status === "success" && (
              <Box>
                <Text size="1" color="gray">
                  Result
                </Text>
                <Code size="1" style={{ display: "block", whiteSpace: "pre-wrap" }}>
                  {formatToolValue(entry.result)}
                </Code>
              </Box>
            )}
            {entry.status === "error" && (
              <Box>
                <Text size="1" color="red">
                  Error
                </Text>
                <Code size="1" color="red" style={{ display: "block", whiteSpace: "pre-wrap" }}>
                  {entry.error}
                </Code>
              </Box>
            )}
          </Flex>
        </details>
      </Card>
    </Box>
  );
}
