/**
 * Custom message renderer: `system-testing.stage-report`.
 *
 * A full-width report card posted after each test category/stage. Header (title
 * + pass/fail/errored badges + duration) and the agent's prose summary are
 * always visible; the per-test table and per-failure diagnostics live behind
 * in-card disclosures. The detail views are designed UI — a chat-styled
 * transcript, a status-badged invocation table, participant chips, and bulleted
 * event lists — never a raw JSON dump.
 */

import { useState, type MouseEvent, type ReactNode } from "react";
import {
  Badge,
  Box,
  Callout,
  Card,
  Code,
  Flex,
  Heading,
  IconButton,
  Separator,
  Text,
} from "@radix-ui/themes";
import {
  CheckIcon,
  CheckCircledIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  ClipboardCopyIcon,
  CrossCircledIcon,
  ExclamationTriangleIcon,
} from "@radix-ui/react-icons";

// Shared types come from the sibling `report-types.ts`. This is a type-only
// import, so the sandbox compiler erases it — `report-types.ts` is never
// fetched into the panel context.
import type {
  FailureDiagnostic,
  StageReportCounts,
  StageReportState,
  StageTestRow,
} from "./report-types.js";

type RadixColor = "green" | "red" | "amber" | "blue" | "gray";

// ---------------------------------------------------------------------------
// Schema (dogfoods the custom-message schema-validation feature)
// ---------------------------------------------------------------------------

export function schema(state: unknown): string[] | null {
  if (!state || typeof state !== "object") return ["stage report state must be an object"];
  const s = state as Partial<StageReportState>;
  const errors: string[] = [];
  if (!s.runId) errors.push("missing runId");
  if (!s.category) errors.push("missing category");
  if (!s.counts || typeof s.counts !== "object") errors.push("missing counts");
  if (!Array.isArray(s.tests)) errors.push("tests must be an array");
  return errors.length ? errors : null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (!ms || ms < 0) return "0s";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

/** Prefix-based mapping for `likelyIssue` (values may carry a `:names` suffix). */
function classifyIssue(likelyIssue: string): { prefix: string; suffix: string; color: RadixColor } {
  const [prefix, ...rest] = (likelyIssue ?? "").split(":");
  const suffix = rest.join(":");
  let color: RadixColor = "gray";
  if (prefix === "session-error" || prefix === "tool-error") color = "red";
  else if (
    prefix === "cleanup-error" ||
    prefix === "incomplete-invocation" ||
    prefix === "tool-failure-observed"
  )
    color = "amber";
  else if (prefix === "no-final-agent-message" || prefix === "validation-mismatch") color = "blue";
  return { prefix: prefix || "unknown", suffix, color };
}

function clipboardText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined) return "undefined";
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function writeClipboard(value: unknown): void {
  try {
    const text = clipboardText(value);
    void (
      globalThis as { navigator?: { clipboard?: { writeText?: (t: string) => unknown } } }
    ).navigator?.clipboard?.writeText?.(text);
  } catch {
    /* clipboard best-effort */
  }
}

function CopyButton({
  value,
  title = "Copy details",
  color = "gray",
}: {
  value: unknown;
  title?: string;
  color?: RadixColor;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <IconButton
      size="1"
      variant="ghost"
      color={color}
      title={copied ? "Copied" : title}
      aria-label={copied ? "Copied" : title}
      onClick={(event: MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        event.stopPropagation();
        writeClipboard(value);
        setCopied(true);
        globalThis.setTimeout(() => setCopied(false), 1200);
      }}
      style={{ flexShrink: 0 }}
    >
      {copied ? <CheckIcon /> : <ClipboardCopyIcon />}
    </IconButton>
  );
}

// ---------------------------------------------------------------------------
// Generic disclosure
// ---------------------------------------------------------------------------

function Disclosure({
  label,
  count,
  defaultOpen = false,
  color = "gray",
  copyValue,
  copyTitle,
  children,
}: {
  label: string;
  count?: number;
  defaultOpen?: boolean;
  color?: RadixColor;
  copyValue?: unknown;
  copyTitle?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Box>
      <Flex
        align="center"
        gap="1"
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: "pointer", userSelect: "none", padding: "2px 0" }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <Text size="2" weight="medium" color={color === "gray" ? undefined : color}>
          {label}
        </Text>
        {typeof count === "number" && (
          <Badge size="1" color={color} variant="soft">
            {count}
          </Badge>
        )}
        {copyValue !== undefined && (
          <CopyButton value={copyValue} title={copyTitle ?? `Copy ${label}`} color={color} />
        )}
      </Flex>
      {open && (
        <Box mt="2" ml="3">
          {children}
        </Box>
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function StatusBadges({ counts }: { counts: StageReportCounts }) {
  return (
    <Flex align="center" gap="2" wrap="wrap">
      <Badge color="green" variant="soft">
        <CheckCircledIcon /> {counts.passed}
      </Badge>
      <Badge color={counts.failed ? "red" : "gray"} variant="soft">
        <CrossCircledIcon /> {counts.failed}
      </Badge>
      <Badge color={counts.errored ? "amber" : "gray"} variant="soft">
        <ExclamationTriangleIcon /> {counts.errored}
      </Badge>
      {(counts.toolFailureCount ?? 0) > 0 && (
        <Badge color="amber" variant="soft">
          tools {counts.toolFailureCount}
        </Badge>
      )}
      <Text size="1" color="gray">
        {formatDuration(counts.durationMs)}
      </Text>
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// Test table
// ---------------------------------------------------------------------------

function statusColor(status: StageTestRow["status"]): RadixColor {
  if (status === "passed") return "green";
  if (status === "errored") return "amber";
  return "red";
}

function StatusIcon({ status }: { status: StageTestRow["status"] }) {
  if (status === "passed") return <CheckCircledIcon color="var(--green-9)" />;
  if (status === "errored") return <ExclamationTriangleIcon color="var(--amber-9)" />;
  return <CrossCircledIcon color="var(--red-9)" />;
}

function TestRow({ test, defaultOpen = false }: { test: StageTestRow; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const turns = test.detail?.conversation?.length ?? 0;
  const calls = test.detail?.invocations?.length ?? 0;
  const toolFailures = test.toolFailureCount ?? 0;
  return (
    <Box style={{ borderBottom: "1px solid var(--gray-a3)" }}>
      <Flex
        align="center"
        gap="2"
        py="1"
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: "pointer" }}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
      >
        {open ? <ChevronDownIcon /> : <ChevronRightIcon />}
        <StatusIcon status={test.status} />
        <Code size="2" variant="ghost" style={{ flex: 1, minWidth: 0 }}>
          {test.name}
        </Code>
        {turns > 0 && (
          <Text size="1" color="gray">
            {turns} msg
          </Text>
        )}
        {calls > 0 && (
          <Text size="1" color="gray">
            {calls} calls
          </Text>
        )}
        {toolFailures > 0 && (
          <Badge size="1" color="amber" variant="soft">
            {toolFailures} tool error{toolFailures === 1 ? "" : "s"}
          </Badge>
        )}
        <CopyButton
          value={test}
          title={`Copy ${test.name} test details`}
          color={statusColor(test.status)}
        />
        <Text size="1" color="gray">
          {formatDuration(test.durationMs)}
        </Text>
      </Flex>
      {!open && test.reason && test.status !== "passed" && (
        <Box ml="6" pb="1">
          <Text
            size="1"
            color={statusColor(test.status)}
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 2,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {test.reason}
          </Text>
        </Box>
      )}
      {open && (
        <Box ml="6" pb="2">
          {test.detail ? (
            <TestDetail diagnostic={test.detail} />
          ) : (
            <Text size="1" color="gray">
              No diagnostics captured for this test.
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

function TestTable({ tests }: { tests: StageTestRow[] }) {
  return (
    <Box>
      {tests.map((test) => (
        <TestRow key={test.name} test={test} />
      ))}
    </Box>
  );
}

function ToolFailureList({ tests }: { tests: StageTestRow[] }) {
  return (
    <Flex direction="column" gap="2">
      {tests.map((test) => (
        <Box
          key={test.name}
          p="2"
          style={{
            border: "1px solid var(--amber-a4)",
            borderRadius: 4,
            background: "var(--amber-a2)",
          }}
        >
          <Flex align="center" justify="between" gap="2" mb="1">
            <Flex align="center" gap="2" wrap="wrap" style={{ minWidth: 0 }}>
              <Code size="2" variant="ghost">
                {test.name}
              </Code>
              <Badge size="1" color="amber" variant="soft">
                {test.toolFailureCount ?? test.toolFailures?.length ?? 0}
              </Badge>
            </Flex>
            <CopyButton value={test} title={`Copy ${test.name} tool failures`} color="amber" />
          </Flex>
          <Flex direction="column" gap="1">
            {(test.toolFailures ?? []).map((failure, index) => (
              <Flex key={`${failure.id ?? failure.name}-${index}`} align="start" gap="2">
                <Code size="1" variant="soft" color="amber">
                  {failure.name}
                </Code>
                <Text size="1" style={{ overflowWrap: "anywhere" }}>
                  {[failure.status, failure.terminalOutcome, failure.error ?? failure.resultSummary]
                    .filter(Boolean)
                    .join(" · ") || "tool failure"}
                </Text>
              </Flex>
            ))}
          </Flex>
        </Box>
      ))}
    </Flex>
  );
}

// ---------------------------------------------------------------------------
// Failure detail (typed drill-down views)
// ---------------------------------------------------------------------------

function LabeledCallout({
  label,
  color,
  copyValue,
  children,
}: {
  label: string;
  color: RadixColor;
  copyValue?: unknown;
  children: ReactNode;
}) {
  const inferredCopyValue =
    copyValue ??
    (typeof children === "string" || typeof children === "number" ? String(children) : undefined);
  return (
    <Callout.Root color={color} size="1" my="1">
      <Callout.Text>
        <Flex align="start" gap="2">
          <Box style={{ flex: 1, minWidth: 0 }}>
            <Text size="1" weight="medium">
              {label}:{" "}
            </Text>
            <Text size="1" style={{ whiteSpace: "pre-wrap" }}>
              {children}
            </Text>
          </Box>
          {inferredCopyValue !== undefined && (
            <CopyButton value={inferredCopyValue} title={`Copy ${label}`} color={color} />
          )}
        </Flex>
      </Callout.Text>
    </Callout.Root>
  );
}

function countBy(values: string[]): Array<{ label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function invocationColor(inv: FailureDiagnostic["invocations"][number]): RadixColor {
  if (inv.error || inv.isError || inv.status === "error" || inv.status === "failed") return "red";
  if (inv.status === "pending" || inv.status === "cancelled" || inv.status === "abandoned")
    return "amber";
  if (inv.status === "complete" || inv.status === "completed") return "green";
  return "gray";
}

function messageColor(turn: FailureDiagnostic["conversation"][number]): RadixColor {
  if (turn.error) return "red";
  if (turn.uiType === "invocation" && turn.invocation) return invocationColor(turn.invocation);
  if (turn.uiType === "diagnostic") return turn.diagnostic?.severity === "error" ? "red" : "amber";
  if (turn.pending || turn.complete === false || turn.uiType === "typing") return "amber";
  if (turn.who === "agent") return "blue";
  return "gray";
}

function readableType(value: string | undefined): string {
  return (value || "message").replace(/[-_]+/g, " ");
}

function valueType(value: unknown): string {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  return typeof value;
}

function valueSummary(value: unknown): string {
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? "" : "s"}`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value);
    return keys.length
      ? keys.slice(0, 4).join(", ") + (keys.length > 4 ? ` +${keys.length - 4}` : "")
      : "empty object";
  }
  if (typeof value === "string") return value.length > 90 ? `${value.slice(0, 90)}...` : value;
  if (value === undefined) return "undefined";
  return String(value);
}

function RawTextBlock({ text, title = "Copy raw text" }: { text: string; title?: string }) {
  return (
    <Box
      p="2"
      style={{
        border: "1px solid var(--gray-a4)",
        borderRadius: 4,
        background: "var(--gray-a2)",
        overflowX: "auto",
      }}
    >
      <Flex justify="end" mb="1">
        <CopyButton value={text} title={title} />
      </Flex>
      <Text
        size="1"
        style={{
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          fontFamily: "var(--font-mono, monospace)",
          display: "block",
        }}
      >
        {text}
      </Text>
    </Box>
  );
}

function KeyValueList({ items }: { items: Array<{ label: string; value: unknown }> }) {
  const filtered = items.filter(
    (item) => item.value !== undefined && item.value !== null && item.value !== ""
  );
  if (filtered.length === 0) return null;
  return (
    <Flex direction="column" gap="1">
      {filtered.map((item) => (
        <Flex key={item.label} align="start" gap="2" wrap="wrap">
          <Code size="1" variant="soft" style={{ flexShrink: 0 }}>
            {item.label}
          </Code>
          <Text size="1" color="gray" style={{ overflowWrap: "anywhere" }}>
            {String(item.value)}
          </Text>
        </Flex>
      ))}
    </Flex>
  );
}

function ValueTree({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const type = valueType(value);
  if (value === undefined || value === null || typeof value !== "object") {
    return (
      <Text
        size="1"
        style={{
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          fontFamily: typeof value === "string" ? undefined : "var(--font-mono, monospace)",
        }}
      >
        {value === undefined ? "undefined" : value === null ? "null" : String(value)}
      </Text>
    );
  }

  if (depth >= 2) {
    return (
      <Text size="1" color="gray">
        {valueSummary(value)}
      </Text>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((child, index) => [String(index), child] as const)
    : Object.entries(value as Record<string, unknown>);
  if (entries.length === 0)
    return (
      <Text size="1" color="gray">
        empty {type}
      </Text>
    );

  return (
    <Flex direction="column" gap="1">
      {entries.slice(0, 12).map(([key, child]) => (
        <Box key={key} style={{ borderLeft: "1px solid var(--gray-a4)", paddingLeft: 8 }}>
          <Flex align="start" gap="2">
            <Code
              size="1"
              variant="ghost"
              style={{ minWidth: 44, maxWidth: 180, overflowWrap: "anywhere" }}
            >
              {key}
            </Code>
            <Box style={{ flex: 1, minWidth: 0 }}>
              <ValueTree value={child} depth={depth + 1} />
            </Box>
          </Flex>
        </Box>
      ))}
      {entries.length > 12 && (
        <Text size="1" color="gray">
          +{entries.length - 12} more {Array.isArray(value) ? "items" : "fields"}
        </Text>
      )}
    </Flex>
  );
}

function ValueBlock({
  label,
  value,
  color = "gray",
}: {
  label: string;
  value: unknown;
  color?: RadixColor;
}) {
  return (
    <Box
      p="2"
      style={{
        border: `1px solid var(--${color}-a4)`,
        borderRadius: 4,
        background: `var(--${color}-a2)`,
      }}
    >
      <Flex align="center" justify="between" gap="2" mb="1" wrap="wrap">
        <Flex align="center" gap="2" wrap="wrap" style={{ minWidth: 0 }}>
          <Text size="1" weight="medium">
            {label}
          </Text>
          <Badge size="1" color={color} variant="soft">
            {valueType(value)}
          </Badge>
          <Text size="1" color="gray" style={{ overflowWrap: "anywhere" }}>
            {valueSummary(value)}
          </Text>
        </Flex>
        <CopyButton value={value} title={`Copy ${label}`} color={color} />
      </Flex>
      <ValueTree value={value} />
    </Box>
  );
}

function hasStructuredValue(value: unknown): boolean {
  return value !== undefined;
}

function InvocationDetails({ inv }: { inv: FailureDiagnostic["invocations"][number] }) {
  const color = invocationColor(inv);
  const hasArguments = inv.arguments && Object.keys(inv.arguments).length > 0;
  const resultColor = inv.error || inv.isError ? "red" : "green";
  return (
    <Flex direction="column" gap="2">
      <Flex align="center" justify="between" gap="2">
        <Text size="1" weight="medium">
          Tool call details
        </Text>
        <CopyButton value={inv} title={`Copy ${inv.name} tool call`} color={color} />
      </Flex>
      <KeyValueList
        items={[
          { label: "id", value: inv.id },
          { label: "transport", value: inv.transportCallId },
          { label: "status", value: inv.status },
          { label: "outcome", value: inv.terminalOutcome },
          { label: "reason", value: inv.terminalReasonCode },
        ]}
      />
      {inv.description && (
        <LabeledCallout label="Description" color={color}>
          {inv.description}
        </LabeledCallout>
      )}
      {inv.error && (
        <LabeledCallout label="Error" color="red">
          {inv.error}
        </LabeledCallout>
      )}
      {hasArguments && <ValueBlock label="Arguments" value={inv.arguments} color="blue" />}
      {hasStructuredValue(inv.result) && (
        <ValueBlock
          label={inv.error || inv.isError ? "Error result" : "Result"}
          value={inv.result}
          color={resultColor}
        />
      )}
      {inv.consoleOutput && (
        <Disclosure label="Console output" defaultOpen={false}>
          <RawTextBlock text={inv.consoleOutput} />
        </Disclosure>
      )}
      {!hasArguments && inv.argumentSummary && (
        <LabeledCallout label="Args" color="gray">
          {inv.argumentSummary}
        </LabeledCallout>
      )}
      {!hasStructuredValue(inv.result) && inv.resultSummary && (
        <LabeledCallout label="Result" color="gray">
          {inv.resultSummary}
        </LabeledCallout>
      )}
    </Flex>
  );
}

function TypeSummary({ diagnostic }: { diagnostic: FailureDiagnostic }) {
  const messageTypes = countBy(diagnostic.conversation.map((turn) => turn.uiType || turn.type));
  const invocationStatuses = countBy(diagnostic.invocations.map((inv) => inv.status));
  return (
    <Flex direction="column" gap="1">
      <Flex align="center" gap="2" wrap="wrap">
        <Text size="1" color="gray">
          message types
        </Text>
        {messageTypes.length === 0 ? (
          <Badge size="1" color="gray" variant="soft">
            none
          </Badge>
        ) : (
          messageTypes.map((item) => (
            <Badge key={item.label} size="1" color="blue" variant="soft">
              {readableType(item.label)} {item.count}
            </Badge>
          ))
        )}
      </Flex>
      <Flex align="center" gap="2" wrap="wrap">
        <Text size="1" color="gray">
          tool states
        </Text>
        {invocationStatuses.length === 0 ? (
          <Badge size="1" color="gray" variant="soft">
            none
          </Badge>
        ) : (
          invocationStatuses.map((item) => (
            <Badge
              key={item.label}
              size="1"
              color={item.label === "complete" ? "green" : item.label === "error" ? "red" : "amber"}
              variant="soft"
            >
              {item.label} {item.count}
            </Badge>
          ))
        )}
      </Flex>
    </Flex>
  );
}

function MessageSpecificDetails({ turn }: { turn: FailureDiagnostic["conversation"][number] }) {
  if (turn.invocation) return <InvocationDetails inv={turn.invocation} />;
  if (turn.diagnostic) {
    return (
      <Flex direction="column" gap="2">
        <KeyValueList
          items={[
            { label: "severity", value: turn.diagnostic.severity },
            { label: "code", value: turn.diagnostic.code },
            { label: "reason", value: turn.diagnostic.reason },
          ]}
        />
        {turn.diagnostic.title && (
          <LabeledCallout label="Title" color={messageColor(turn)}>
            {turn.diagnostic.title}
          </LabeledCallout>
        )}
        {turn.diagnostic.detail && (
          <LabeledCallout label="Detail" color={messageColor(turn)}>
            {turn.diagnostic.detail}
          </LabeledCallout>
        )}
      </Flex>
    );
  }
  if (turn.lifecycle) {
    return (
      <Flex direction="column" gap="2">
        <KeyValueList
          items={[
            { label: "status", value: turn.lifecycle.status },
            { label: "reason", value: turn.lifecycle.reason },
          ]}
        />
        {turn.lifecycle.title && (
          <LabeledCallout label="Title" color={messageColor(turn)}>
            {turn.lifecycle.title}
          </LabeledCallout>
        )}
        {turn.lifecycle.detail && (
          <LabeledCallout label="Detail" color={messageColor(turn)}>
            {turn.lifecycle.detail}
          </LabeledCallout>
        )}
      </Flex>
    );
  }
  if (turn.approval) {
    return (
      <KeyValueList
        items={[
          { label: "id", value: turn.approval.id },
          { label: "status", value: turn.approval.status },
          { label: "question", value: turn.approval.question },
          { label: "reason", value: turn.approval.reason },
        ]}
      />
    );
  }
  if (turn.custom) {
    return (
      <KeyValueList
        items={[
          { label: "message", value: turn.custom.messageId },
          { label: "type", value: turn.custom.typeId },
          { label: "mode", value: turn.custom.displayMode },
          { label: "updates", value: turn.custom.updateCount },
          { label: "failed", value: turn.custom.failed },
          { label: "error", value: turn.custom.error },
        ]}
      />
    );
  }
  if (turn.inlineUi) {
    return (
      <KeyValueList
        items={[
          { label: "id", value: turn.inlineUi.id },
          { label: "source", value: turn.inlineUi.sourceType },
          { label: "path", value: turn.inlineUi.path },
        ]}
      />
    );
  }
  return null;
}

function TimelineItem({
  turn,
  index,
}: {
  turn: FailureDiagnostic["conversation"][number];
  index: number;
}) {
  const [open, setOpen] = useState(false);
  const color = messageColor(turn);
  const title = turn.invocation ? turn.invocation.name : readableType(turn.uiType || turn.type);
  const hasDetails = Boolean(
    turn.invocation ||
    turn.diagnostic ||
    turn.lifecycle ||
    turn.approval ||
    turn.custom ||
    turn.inlineUi ||
    turn.rawContent ||
    turn.id ||
    turn.senderId
  );
  return (
    <Box
      style={{
        borderLeft: `2px solid var(--${color}-7)`,
        background: turn.who === "agent" ? "var(--gray-a2)" : "transparent",
        borderRadius: 4,
      }}
      p="1"
    >
      <Flex
        align="start"
        gap="2"
        onClick={hasDetails ? () => setOpen((v) => !v) : undefined}
        role={hasDetails ? "button" : undefined}
        tabIndex={hasDetails ? 0 : undefined}
        onKeyDown={(e) => {
          if (!hasDetails) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        style={{
          cursor: hasDetails ? "pointer" : "default",
          userSelect: hasDetails ? "none" : undefined,
        }}
      >
        {hasDetails ? (
          open ? (
            <ChevronDownIcon />
          ) : (
            <ChevronRightIcon />
          )
        ) : (
          <Box style={{ width: 15 }} />
        )}
        <Badge size="1" color={color} variant="soft">
          #{index + 1}
        </Badge>
        <Badge size="1" color={turn.who === "agent" ? "blue" : "gray"} variant="soft">
          {turn.who}
        </Badge>
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Flex align="center" gap="2" wrap="wrap">
            <Code size="1" variant="ghost">
              {title}
            </Code>
            <Text size="1" color="gray">
              {readableType(turn.kind)}
              {turn.contentType ? ` / ${readableType(turn.contentType)}` : ""}
            </Text>
            {turn.pending && (
              <Badge size="1" color="amber" variant="surface">
                pending
              </Badge>
            )}
            {turn.complete === false && (
              <Badge size="1" color="amber" variant="surface">
                incomplete
              </Badge>
            )}
            {turn.invocation?.terminalOutcome && (
              <Badge size="1" color={color} variant="soft">
                {turn.invocation.terminalOutcome}
              </Badge>
            )}
          </Flex>
          {turn.text && (
            <Text
              size="1"
              color={turn.error ? "red" : undefined}
              style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", display: "block" }}
            >
              {turn.error || turn.text}
            </Text>
          )}
        </Box>
        <CopyButton value={turn} title={`Copy event #${index + 1}`} color={color} />
      </Flex>

      {open && (
        <Box ml="6" mt="2">
          <Flex direction="column" gap="2">
            <MessageSpecificDetails turn={turn} />
            <Disclosure label="Message fields">
              <KeyValueList
                items={[
                  { label: "id", value: turn.id },
                  { label: "sender", value: turn.senderName ?? turn.senderId },
                  { label: "sender type", value: turn.senderType },
                  { label: "kind", value: turn.kind },
                  { label: "content type", value: turn.contentType },
                  { label: "complete", value: turn.complete },
                  { label: "pending", value: turn.pending },
                ]}
              />
            </Disclosure>
            {turn.rawContent && (
              <Disclosure label="Raw content">
                <RawTextBlock text={turn.rawContent} />
              </Disclosure>
            )}
          </Flex>
        </Box>
      )}
    </Box>
  );
}

function Transcript({ conversation }: { conversation: FailureDiagnostic["conversation"] }) {
  return (
    <Flex direction="column" gap="2">
      {conversation.map((turn, i) => (
        <TimelineItem key={turn.id ?? i} turn={turn} index={i} />
      ))}
    </Flex>
  );
}

function InvocationRow({ inv }: { inv: FailureDiagnostic["invocations"][number] }) {
  const [open, setOpen] = useState(false);
  const color = invocationColor(inv);
  const hasDetail = Boolean(
    inv.argumentSummary ||
    inv.resultSummary ||
    inv.error ||
    inv.arguments ||
    hasStructuredValue(inv.result) ||
    inv.consoleOutput
  );
  return (
    <Box style={{ borderBottom: "1px solid var(--gray-a3)" }} py="1">
      <Flex
        align="center"
        gap="2"
        onClick={hasDetail ? () => setOpen((v) => !v) : undefined}
        style={{ cursor: hasDetail ? "pointer" : "default" }}
      >
        {hasDetail ? (
          open ? (
            <ChevronDownIcon />
          ) : (
            <ChevronRightIcon />
          )
        ) : (
          <Box style={{ width: 15 }} />
        )}
        <Code size="1" variant="ghost" style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
          {inv.name}
        </Code>
        <Badge size="1" color={color} variant="soft">
          {inv.status}
        </Badge>
        {inv.terminalOutcome && (
          <Badge size="1" color={color} variant="surface">
            {inv.terminalOutcome}
          </Badge>
        )}
        <CopyButton value={inv} title={`Copy ${inv.name} tool call`} color={color} />
      </Flex>
      {inv.error && !open && (
        <Box ml="6">
          <Text
            size="1"
            color="red"
            style={{
              display: "-webkit-box",
              WebkitLineClamp: 1,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {inv.error}
          </Text>
        </Box>
      )}
      {open && (
        <Box ml="6" mt="1">
          <InvocationDetails inv={inv} />
        </Box>
      )}
    </Box>
  );
}

function BulletList({ items }: { items: string[] }) {
  return (
    <Flex direction="column" gap="1">
      <Flex justify="end">
        <CopyButton value={items} title="Copy all entries" />
      </Flex>
      {items.map((item, i) => (
        <Flex key={i} align="start" gap="1">
          <Code size="1" variant="soft" style={{ whiteSpace: "pre-wrap", flex: 1, minWidth: 0 }}>
            {item}
          </Code>
          <CopyButton value={item} title={`Copy entry ${i + 1}`} />
        </Flex>
      ))}
    </Flex>
  );
}

function Participants({ participants }: { participants: FailureDiagnostic["participants"] }) {
  return (
    <Flex direction="column" gap="2">
      <Flex justify="end">
        <CopyButton value={participants} title="Copy participants" />
      </Flex>
      <Flex gap="2" wrap="wrap">
        {participants.map((p) => (
          <Flex key={p.id} align="center" gap="1">
            <Badge variant="soft" color={p.connected === false ? "red" : "green"}>
              <Box
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  background: p.connected === false ? "var(--red-9)" : "var(--green-9)",
                }}
              />
              {p.name ?? p.id}
              {p.type ? ` · ${p.type}` : ""}
            </Badge>
            <CopyButton
              value={p}
              title={`Copy ${p.name ?? p.id} participant`}
              color={p.connected === false ? "red" : "green"}
            />
          </Flex>
        ))}
      </Flex>
    </Flex>
  );
}

function TestDetail({
  diagnostic,
  defaultOpenTranscript = false,
}: {
  diagnostic: FailureDiagnostic;
  defaultOpenTranscript?: boolean;
}) {
  const issue = classifyIssue(diagnostic.likelyIssue);
  return (
    <Box
      my="1"
      p="2"
      style={{
        border: "1px solid var(--gray-a4)",
        borderRadius: 6,
        background: "var(--gray-a1)",
      }}
    >
      <Flex direction="column" gap="2">
        <Flex align="center" justify="between" gap="2" wrap="wrap">
          <Flex align="center" gap="2">
            <Code size="2">{diagnostic.name}</Code>
            {diagnostic.passed ? (
              <Badge color="green" variant="soft">
                <CheckCircledIcon /> passed
              </Badge>
            ) : (
              <Badge color={issue.color} variant="solid">
                {issue.prefix}
                {issue.suffix ? (
                  <Text size="1" style={{ opacity: 0.8 }}>
                    &nbsp;{issue.suffix}
                  </Text>
                ) : null}
              </Badge>
            )}
          </Flex>
          <Flex align="center" gap="2">
            <Text size="1" color="gray">
              {formatDuration(diagnostic.durationMs)}
            </Text>
            <CopyButton value={diagnostic} title={`Copy ${diagnostic.name} diagnostic`} />
          </Flex>
        </Flex>

        <Text size="1" color="gray" style={{ whiteSpace: "pre-wrap" }}>
          {diagnostic.prompt}
        </Text>
        <TypeSummary diagnostic={diagnostic} />

        {diagnostic.validationReason && (
          <LabeledCallout label="Validation" color="red">
            {diagnostic.validationReason}
          </LabeledCallout>
        )}
        {diagnostic.sessionError && (
          <LabeledCallout label="Session error" color="red">
            {diagnostic.sessionError}
          </LabeledCallout>
        )}
        {diagnostic.finalAgentMessage && (
          <LabeledCallout label="Final agent message" color="gray">
            {diagnostic.finalAgentMessage}
          </LabeledCallout>
        )}

        {diagnostic.conversation.length > 0 && (
          <Disclosure
            label="Event timeline"
            count={diagnostic.conversation.length}
            defaultOpen={defaultOpenTranscript}
            copyValue={diagnostic.conversation}
            copyTitle="Copy event timeline"
          >
            <Transcript conversation={diagnostic.conversation} />
          </Disclosure>
        )}
        {diagnostic.invocations.length > 0 && (
          <Disclosure
            label="Tool calls"
            count={diagnostic.invocations.length}
            copyValue={diagnostic.invocations}
            copyTitle="Copy tool calls"
          >
            <Box>
              {diagnostic.invocations.map((inv, i) => (
                <InvocationRow key={i} inv={inv} />
              ))}
            </Box>
          </Disclosure>
        )}
        {diagnostic.debugEvents.length > 0 && (
          <Disclosure
            label="Debug events"
            count={diagnostic.debugEvents.length}
            copyValue={diagnostic.debugEvents}
            copyTitle="Copy debug events"
          >
            <BulletList items={diagnostic.debugEvents} />
          </Disclosure>
        )}
        {diagnostic.cleanupErrors.length > 0 && (
          <Disclosure
            label="Cleanup errors"
            count={diagnostic.cleanupErrors.length}
            color="amber"
            copyValue={diagnostic.cleanupErrors}
            copyTitle="Copy cleanup errors"
          >
            <BulletList items={diagnostic.cleanupErrors} />
          </Disclosure>
        )}
        {diagnostic.participants.length > 0 && (
          <Disclosure
            label="Participants"
            count={diagnostic.participants.length}
            copyValue={diagnostic.participants}
            copyTitle="Copy participants"
          >
            <Participants participants={diagnostic.participants} />
          </Disclosure>
        )}
      </Flex>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Card
// ---------------------------------------------------------------------------

export default function StageReport({ state }: { state: StageReportState }) {
  if (!state || !state.category) {
    return (
      <Card>
        <Text size="1" color="gray">
          (empty stage report)
        </Text>
      </Card>
    );
  }
  const anyFail = state.counts.failed > 0 || state.counts.errored > 0;
  const anyToolFailure = (state.counts.toolFailureCount ?? 0) > 0;
  const borderColor = anyFail ? "red" : anyToolFailure ? "amber" : "green";
  const failing = state.tests.filter((t) => !t.passed);
  const testsWithToolFailures = state.tests.filter((t) => (t.toolFailureCount ?? 0) > 0);
  return (
    <Card
      className="message-card"
      style={{ borderLeft: `3px solid var(--${borderColor}-9)` }}
    >
      <Flex direction="column" gap="3">
        <Flex align="center" justify="between" gap="3" wrap="wrap">
          <Flex align="center" gap="2">
            {anyFail ? (
              <CrossCircledIcon color="var(--red-9)" />
            ) : anyToolFailure ? (
              <ExclamationTriangleIcon color="var(--amber-9)" />
            ) : (
              <CheckCircledIcon color="var(--green-9)" />
            )}
            <Heading size="3">{state.title}</Heading>
            <Text size="1" color="gray">
              stage
            </Text>
          </Flex>
          <Flex align="center" gap="2" wrap="wrap">
            <StatusBadges counts={state.counts} />
            <CopyButton value={state} title={`Copy ${state.title} stage report`} />
          </Flex>
        </Flex>

        {state.prose && (
          <Text size="2" style={{ whiteSpace: "pre-wrap" }}>
            {state.prose}
          </Text>
        )}

        <Separator size="4" />

        {testsWithToolFailures.length > 0 && (
          <Disclosure
            label="Tool failures to investigate"
            count={state.counts.toolFailureCount}
            color="amber"
            defaultOpen={!anyFail}
            copyValue={testsWithToolFailures}
            copyTitle="Copy tool failures"
          >
            <ToolFailureList tests={testsWithToolFailures} />
          </Disclosure>
        )}

        {failing.length > 0 && (
          <Disclosure
            label="Failures"
            count={failing.length}
            color="red"
            defaultOpen={failing.length <= 3}
            copyValue={failing}
            copyTitle="Copy failures"
          >
            <Flex direction="column" gap="2">
              {failing.map((test) => (
                <TestDetail
                  key={test.name}
                  diagnostic={test.detail}
                  defaultOpenTranscript={failing.length === 1}
                />
              ))}
            </Flex>
          </Disclosure>
        )}

        <Disclosure
          label="All tests"
          count={state.counts.total}
          defaultOpen={!anyFail && !anyToolFailure}
          copyValue={state.tests}
          copyTitle="Copy all tests"
        >
          <TestTable tests={state.tests} />
        </Disclosure>
      </Flex>
    </Card>
  );
}
