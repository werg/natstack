import React, { useMemo } from "react";
import { Badge, Box, Code, Flex, Spinner, Text } from "@radix-ui/themes";
import { prettifyToolName } from "@natstack/pubsub";
import { ExpandableChevron } from "./shared/Chevron";
import { CollapsibleSection } from "./shared/CollapsibleSection";
import { JsonValue } from "./shared/JsonValue";
import { CodePreview } from "./shared/CodePreview";
import { formatArgsSummary } from "./action-format";
import type { RichActionData } from "./action-types";

// Re-export so existing consumers don't need to change imports yet.
export type { RichActionData } from "./action-types";
export { parseActionData } from "./action-types";

// ── Status helpers ─────────────────────────────────────────────────────────

const STATUS_DOT_COLOR = {
  pending: "var(--gray-8)",
  complete: "var(--green-9)",
  error: "var(--red-9)",
} as const;

type StatusKey = "pending" | "complete" | "error";

function getStatusKey(data: RichActionData): StatusKey {
  if (data.status === "pending") return "pending";
  return data.isError ? "error" : "complete";
}

function getStatusColor(sk: StatusKey): "red" | "amber" | "green" {
  return sk === "error" ? "red" : sk === "pending" ? "amber" : "green";
}

function StatusDot({ statusKey }: { statusKey: StatusKey }) {
  return (
    <Box
      style={{
        width: 6, height: 6, borderRadius: "50%",
        backgroundColor: STATUS_DOT_COLOR[statusKey], flexShrink: 0,
      }}
    />
  );
}

/** Tool types whose `code` arg should be syntax-highlighted. */
const CODE_TOOL_TYPES = new Set(["eval", "inline_ui", "feedback_custom"]);

// ── ActionPill (collapsed view) ────────────────────────────────────────────

export const ActionPill = React.memo(function ActionPill({
  id,
  data,
  onExpand,
}: {
  id: string;
  data: RichActionData;
  onExpand: (id: string) => void;
}) {
  const statusKey = getStatusKey(data);
  const isPending = statusKey === "pending";
  const color = getStatusColor(statusKey);

  const argsSummary = useMemo(() => formatArgsSummary(data.args, 50), [data.args]);

  return (
    <Flex
      align="center"
      gap="1"
      onClick={() => onExpand(id)}
      tabIndex={0}
      style={{
        cursor: "pointer",
        userSelect: "none",
        padding: "2px 6px",
        borderRadius: "4px",
        backgroundColor: `var(--${color}-a3)`,
        border: `1px solid var(--${color}-a5)`,
        display: "inline-flex",
      }}
    >
      {isPending ? <Spinner size="1" /> : <StatusDot statusKey={statusKey} />}
      <Text size="1" color={color} weight="medium">
        {prettifyToolName(data.type)}
      </Text>
      {argsSummary && (
        <Text size="1" color="gray" style={{
          opacity: 0.7, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          ({argsSummary})
        </Text>
      )}
      {data.description && (
        <Text size="1" color="gray" style={{
          opacity: 0.7, maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}>
          {data.description}
        </Text>
      )}
    </Flex>
  );
});

// ── ExpandedAction (expanded view) ─────────────────────────────────────────

export const ExpandedAction = React.memo(function ExpandedAction({
  data,
  onCollapse,
}: {
  data: RichActionData;
  onCollapse: () => void;
}) {
  const statusKey = getStatusKey(data);
  const isPending = statusKey === "pending";
  const isError = statusKey === "error";
  const color = getStatusColor(statusKey);

  const argsSummary = useMemo(() => formatArgsSummary(data.args, 80), [data.args]);

  return (
    <Box
      style={{
        backgroundColor: `var(--${color}-a2)`,
        borderRadius: "6px",
        padding: "8px 10px",
        border: `1px solid var(--${color}-a4)`,
      }}
    >
      <Flex
        align="center"
        gap="2"
        onClick={onCollapse}
        tabIndex={0}
        style={{ cursor: "pointer", userSelect: "none" }}
      >
        <Text color={color} style={{ display: "flex", alignItems: "center" }}>
          <ExpandableChevron expanded={true} />
        </Text>
        <StatusDot statusKey={statusKey} />
        <Text size="1" color={color} weight="medium">
          {prettifyToolName(data.type)}
        </Text>
        <Badge color={color} size="1" variant="soft">
          {isError ? "error" : data.status}
        </Badge>
      </Flex>

      <Flex direction="column" gap="2" mt="2" ml="4">
        {data.description && (
          <Text size="1" color="gray" style={{ fontStyle: "italic" }}>
            {data.description}
          </Text>
        )}

        {argsSummary && (
          <Box style={{
            padding: "4px 8px", backgroundColor: "var(--gray-a3)",
            borderRadius: "4px", borderLeft: "2px solid var(--gray-a6)",
          }}>
            <Text size="1" style={{ fontFamily: "var(--code-font-family)" }}>
              {argsSummary}
            </Text>
          </Box>
        )}

        {CODE_TOOL_TYPES.has(data.type) && typeof data.args?.["code"] === "string" && (
          <CodePreview code={data.args["code"] as string} />
        )}

        {data.consoleOutput && (
          <CollapsibleSection label="Console" defaultOpen={true} color="blue">
            <Code size="1" style={{
              display: "block", whiteSpace: "pre-wrap", wordBreak: "break-word",
              padding: "8px", maxHeight: "300px", overflow: "auto", backgroundColor: "var(--gray-a3)",
            }}>
              {data.consoleOutput}
            </Code>
          </CollapsibleSection>
        )}

        {data.args && Object.keys(data.args).length > 0 && (
          <CollapsibleSection label="Args" defaultOpen={false}>
            <Box style={{
              backgroundColor: "var(--gray-a2)", borderRadius: "4px",
              padding: "6px", maxHeight: "300px", overflow: "auto",
            }}>
              <JsonValue value={data.args} />
            </Box>
          </CollapsibleSection>
        )}

        {data.result !== undefined && !isError && (
          <CollapsibleSection label="Result" defaultOpen={!isPending} color="green">
            <Box style={{
              backgroundColor: "var(--gray-a2)", borderRadius: "4px",
              padding: "6px", maxHeight: "300px", overflow: "auto",
            }}>
              <JsonValue value={data.result} />
            </Box>
          </CollapsibleSection>
        )}

        {isError && data.result !== undefined && (
          <CollapsibleSection label="Error" defaultOpen={true} color="red">
            <Box style={{
              padding: "6px", backgroundColor: "var(--red-a3)", borderRadius: "4px",
            }}>
              <Text size="1" color="red" style={{ whiteSpace: "pre-wrap" }}>
                {typeof data.result === "string" ? data.result : JSON.stringify(data.result, null, 2)}
              </Text>
            </Box>
          </CollapsibleSection>
        )}

        {data.resultTruncated && (
          <Text size="1" color="gray" style={{ opacity: 0.6 }}>
            Result truncated
          </Text>
        )}
      </Flex>
    </Box>
  );
});
