import React, { useState, useMemo, useEffect, useRef } from "react";
import { Badge, Box, Code, Flex, Spinner, Text } from "@radix-ui/themes";
import { prettifyToolName } from "@natstack/pubsub";
import { ExpandableChevron } from "./shared/Chevron";

// ── Lazy-loaded highlight.js for code preview ──────────────────────────────

type HLJSApi = typeof import("highlight.js/lib/core").default;
let hljsInstance: HLJSApi | null = null;
let hljsPromise: Promise<HLJSApi> | null = null;
async function getHljs(): Promise<HLJSApi> {
  if (hljsInstance) return hljsInstance;
  if (!hljsPromise) {
    hljsPromise = Promise.all([
      import("highlight.js/lib/core"),
      import("highlight.js/lib/languages/typescript"),
    ]).then(([core, ts]) => {
      hljsInstance = core.default;
      hljsInstance.registerLanguage("typescript", ts.default);
      return hljsInstance;
    });
  }
  return hljsPromise;
}

/** Tool types whose `code` arg should be syntax-highlighted. */
const CODE_TOOL_TYPES = new Set(["eval", "inline_ui", "feedback_custom"]);

function CodePreview({ code }: { code: string }) {
  const ref = useRef<HTMLElement>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getHljs().then((hljs) => {
      if (cancelled) return;
      const result = hljs.highlight(code, { language: "typescript" });
      setHighlighted(result.value);
    });
    return () => { cancelled = true; };
  }, [code]);

  return (
    <pre className="ns-codeblock" style={{ margin: 0, maxHeight: 400, overflow: "auto", borderRadius: 4, fontSize: "12px" }}>
      {highlighted ? (
        <code ref={ref} className="hljs language-typescript" dangerouslySetInnerHTML={{ __html: highlighted }} />
      ) : (
        <code style={{ whiteSpace: "pre-wrap" }}>{code}</code>
      )}
    </pre>
  );
}

export interface RichActionData {
  type: string;
  description: string;
  toolUseId?: string;
  /** Only two canonical values — errors use isError flag. */
  status: "pending" | "complete";
  /** Populated at tool_execution_start/end. */
  args?: Record<string, unknown>;
  /** Populated at tool_execution_end. */
  result?: unknown;
  /** True when tool execution failed — drives red color scheme. */
  isError?: boolean;
  /** True when the result was too large and was truncated. */
  resultTruncated?: boolean;
}

// ── Utility functions ──────────────────────────────────────────────────────

function truncateStr(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
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

/**
 * Create a pretty, human-readable summary of method arguments.
 * Shows key parameters in a concise format with priority key sorting.
 */
function formatArgsSummary(args: unknown, maxLen = 60): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return truncateStr(String(args), maxLen);

  const obj = args as Record<string, unknown>;
  const entries = Object.entries(obj);
  if (entries.length === 0) return "";

  const priorityKeys = ["file_path", "path", "command", "query", "pattern", "url", "code", "content", "message", "name", "title"];

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
    totalLen += part.length + 2;
  }

  return parts.join(", ");
}

// ── CollapsibleSection ─────────────────────────────────────────────────────

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

// ── JsonValue (recursive JSON tree explorer) ───────────────────────────────

function JsonValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  const [isExpanded, setIsExpanded] = useState(depth < 2);

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
        width: 6,
        height: 6,
        borderRadius: "50%",
        backgroundColor: STATUS_DOT_COLOR[statusKey],
        flexShrink: 0,
      }}
    />
  );
}

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
  const bgVar = `var(--${color}-a3)`;
  const borderVar = `var(--${color}-a5)`;

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
        backgroundColor: bgVar,
        border: `1px solid ${borderVar}`,
        display: "inline-flex",
      }}
    >
      {isPending ? <Spinner size="1" /> : <StatusDot statusKey={statusKey} />}
      <Text size="1" color={color} weight="medium">
        {prettifyToolName(data.type)}
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
      {data.description && (
        <Text size="1" color="gray" style={{ opacity: 0.7, maxWidth: "300px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
  const bgVar = `var(--${color}-a2)`;
  const borderVar = `var(--${color}-a4)`;

  const argsSummary = useMemo(() => formatArgsSummary(data.args, 80), [data.args]);

  return (
    <Box
      style={{
        backgroundColor: bgVar,
        borderRadius: "6px",
        padding: "8px 10px",
        border: `1px solid ${borderVar}`,
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

        {CODE_TOOL_TYPES.has(data.type) && typeof data.args?.["code"] === "string" && (
          <CodePreview code={data.args["code"] as string} />
        )}

        {data.args && Object.keys(data.args).length > 0 && (
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
              <JsonValue value={data.args} />
            </Box>
          </CollapsibleSection>
        )}

        {data.result !== undefined && !isError && (
          <CollapsibleSection label="Result" defaultOpen={!isPending} color="green">
            <Box
              style={{
                backgroundColor: "var(--gray-a2)",
                borderRadius: "4px",
                padding: "6px",
                maxHeight: "300px",
                overflow: "auto",
              }}
            >
              <JsonValue value={data.result} />
            </Box>
          </CollapsibleSection>
        )}

        {isError && data.result !== undefined && (
          <CollapsibleSection label="Error" defaultOpen={true} color="red">
            <Box
              style={{
                padding: "6px",
                backgroundColor: "var(--red-a3)",
                borderRadius: "4px",
              }}
            >
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

// ── parseActionData ────────────────────────────────────────────────────────

/**
 * Parse action data from message content, with fallback for malformed content.
 * Handles edge cases like duplicated JSON objects from update() calls.
 * Normalizes legacy `status: "error"` to `status: "complete"` + `isError: true`.
 */
export function parseActionData(content: string, complete?: boolean): RichActionData {
  let data: RichActionData;
  try {
    data = JSON.parse(content);
  } catch {
    // Try to extract the first valid JSON object if content has duplicates
    const firstBrace = content.indexOf("{");
    const closingBrace = findMatchingBrace(content, firstBrace);
    if (firstBrace >= 0 && closingBrace > firstBrace) {
      try {
        data = JSON.parse(content.slice(firstBrace, closingBrace + 1));
      } catch {
        data = { type: "Unknown", description: content.slice(0, 100), status: "pending" };
      }
    } else {
      data = { type: "Unknown", description: content.slice(0, 100), status: "pending" };
    }
  }

  // Normalize legacy status: "error" → status: "complete" + isError: true
  if ((data as { status: string }).status === "error") {
    data.status = "complete";
    data.isError = true;
  }

  // Override status based on message complete flag
  if (complete && data.status !== "complete") {
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
