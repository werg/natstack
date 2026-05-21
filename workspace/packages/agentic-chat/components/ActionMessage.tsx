import React, { useMemo } from "react";
import { Badge, Box, Code, Flex, Spinner, Text } from "@radix-ui/themes";
import { prettifyToolName } from "@workspace/pubsub";
import type { InvocationCardPayload } from "@workspace/agentic-core";
import { ExpandableChevron } from "./shared/Chevron";
import { CollapsibleSection } from "./shared/CollapsibleSection";
import { JsonValue } from "./shared/JsonValue";
import { CodePreview } from "./shared/CodePreview";
import { formatArgsSummary } from "./action-format";

// ── Status helpers ─────────────────────────────────────────────────────────

const STATUS_DOT_COLOR = {
  pending: "var(--gray-8)",
  complete: "var(--green-9)",
  error: "var(--red-9)",
  cancelled: "var(--amber-9)",
  abandoned: "var(--amber-9)",
} as const;

type StatusKey = "pending" | "complete" | "error" | "cancelled" | "abandoned";

function getStatusKey(payload: InvocationCardPayload): StatusKey {
  const status = payload.execution.status;
  if (status === "pending") return "pending";
  if (status === "cancelled") return "cancelled";
  if (status === "abandoned") return "abandoned";
  return payload.execution.isError || status === "error" ? "error" : "complete";
}

function getStatusColor(sk: StatusKey): "red" | "amber" | "green" {
  return sk === "error" ? "red" : sk === "pending" || sk === "cancelled" || sk === "abandoned" ? "amber" : "green";
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
  payload,
  onExpand,
}: {
  id: string;
  payload: InvocationCardPayload;
  onExpand: (id: string) => void;
}) {
  const statusKey = getStatusKey(payload);
  const isPending = statusKey === "pending";
  const color = getStatusColor(statusKey);

  const argsSummary = useMemo(
    () => formatArgsSummary(payload.arguments, 50),
    [payload.arguments],
  );
  const displayName = useMemo(() => prettifyToolName(payload.name), [payload.name]);

  return (
    <Flex
      className="inline-action-pill"
      data-testid="invocation-pill"
      data-invocation-name={payload.name}
      data-invocation-status={statusKey}
      title={payload.name}
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
      }}
    >
      {isPending ? <Spinner size="1" /> : <StatusDot statusKey={statusKey} />}
      <Text className="inline-pill-label" size="1" color={color} weight="medium">
        {displayName}
      </Text>
      {argsSummary && (
        <Text className="inline-pill-summary" size="1" color="gray" style={{
          opacity: 0.85,
        }}>
          ({argsSummary})
        </Text>
      )}
      {payload.execution.description && (
        <Text className="inline-pill-description" size="1" color="gray" style={{
          opacity: 0.85,
        }}>
          {payload.execution.description}
        </Text>
      )}
    </Flex>
  );
});

// ── ExpandedAction (expanded view) ─────────────────────────────────────────

export const ExpandedAction = React.memo(function ExpandedAction({
  payload,
  onCollapse,
}: {
  payload: InvocationCardPayload;
  onCollapse: () => void;
}) {
  const statusKey = getStatusKey(payload);
  const isPending = statusKey === "pending";
  const isError = statusKey === "error";
  const color = getStatusColor(statusKey);

  const argsSummary = useMemo(
    () => formatArgsSummary(payload.arguments, 80),
    [payload.arguments],
  );
  const displayName = useMemo(() => prettifyToolName(payload.name), [payload.name]);

  const exec = payload.execution;
  const hasArgs = Object.keys(payload.arguments).length > 0;

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
          {displayName}
        </Text>
        <Badge color={color} size="1" variant="soft">
          {exec.status}
        </Badge>
      </Flex>

      <Flex direction="column" gap="2" mt="2" ml="4">
        {exec.description && (
          <Text size="1" color="gray" style={{ fontStyle: "italic" }}>
            {exec.description}
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

        {CODE_TOOL_TYPES.has(payload.name) && typeof payload.arguments?.["code"] === "string" && (
          <CodePreview code={payload.arguments["code"] as string} />
        )}

        {exec.consoleOutput && (
          <CollapsibleSection label="Console" defaultOpen={true} color="blue">
            <Code size="1" style={{
              display: "block", whiteSpace: "pre-wrap", wordBreak: "break-word",
              padding: "8px", maxHeight: "300px", overflow: "auto", backgroundColor: "var(--gray-a3)",
            }}>
              {exec.consoleOutput}
            </Code>
          </CollapsibleSection>
        )}

        {hasArgs && (
          <CollapsibleSection label="Args" defaultOpen={false}>
            <Box style={{
              backgroundColor: "var(--gray-a2)", borderRadius: "4px",
              padding: "6px", maxHeight: "300px", overflow: "auto",
            }}>
              <JsonValue value={payload.arguments} />
            </Box>
          </CollapsibleSection>
        )}

        {exec.result !== undefined && !isError && (
          <CollapsibleSection label="Result" defaultOpen={!isPending} color="green">
            <Box style={{
              backgroundColor: "var(--gray-a2)", borderRadius: "4px",
              padding: "6px", maxHeight: "300px", overflow: "auto",
            }}>
              <JsonValue value={exec.result} />
            </Box>
          </CollapsibleSection>
        )}

        {isError && exec.result !== undefined && (
          <CollapsibleSection label="Error" defaultOpen={true} color="red">
            <Box style={{
              padding: "6px", backgroundColor: "var(--red-a3)", borderRadius: "4px",
            }}>
              <Text size="1" color="red" style={{ whiteSpace: "pre-wrap" }}>
                {typeof exec.result === "string" ? exec.result : JSON.stringify(exec.result, null, 2)}
              </Text>
            </Box>
          </CollapsibleSection>
        )}

        {exec.resultImages && exec.resultImages.length > 0 && (
          <CollapsibleSection label="Images" defaultOpen={true} color="blue">
            <Flex gap="2" wrap="wrap">
              {exec.resultImages.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.mimeType};base64,${img.data}`}
                  alt=""
                  style={{
                    maxWidth: "240px", maxHeight: "240px",
                    borderRadius: "4px", border: "1px solid var(--gray-a4)",
                  }}
                />
              ))}
            </Flex>
          </CollapsibleSection>
        )}

        {exec.resultTruncated && (
          <Text size="1" color="gray" style={{ opacity: 0.6 }}>
            Result truncated
          </Text>
        )}
      </Flex>
    </Box>
  );
});
