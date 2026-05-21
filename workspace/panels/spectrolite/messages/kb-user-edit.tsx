/**
 * Custom message type: `kb.user_edit`
 *
 * Published by Spectrolite after every flush. Renders a compact diff card
 * so that any chat panel subscribed to the same channel can see the user's
 * edits and jump straight into the live document.
 *
 * Module shape follows the conventions in
 * `panels/chat/examples/weather-message-type.tsx`:
 *   - default        — full inline card
 *   - Pill           — collapsed one-line representation
 *   - reduce         — unused (each flush is its own immutable message)
 *   - schema         — type tag for tooling
 */

import { Badge, Box, Card, Code, Flex, Link, Text } from "@radix-ui/themes";
import { Pencil1Icon, ExternalLinkIcon } from "@radix-ui/react-icons";
import { buildPanelLink, contextId as runtimeContextId } from "@workspace/runtime";

export interface KbUserEditState {
  path: string;
  unifiedDiff: string;
  addedLines: number;
  removedLines: number;
  mentions: string[];
  at: number;
  /** ContextId of the editing session — preferred for cross-context observers. */
  editorContextId?: string;
}

const MAX_INLINE_DIFF_LINES = 40;

function buildOpenLink(state: KbUserEditState): string {
  return buildPanelLink("panels/spectrolite", {
    contextId: state.editorContextId ?? runtimeContextId ?? undefined,
    stateArgs: { openPath: state.path },
  });
}

function renderDiffLine(line: string, idx: number) {
  let color: "green" | "red" | "gray" = "gray";
  if (line.startsWith("+") && !line.startsWith("+++")) color = "green";
  else if (line.startsWith("-") && !line.startsWith("---")) color = "red";
  else if (line.startsWith("@@")) color = "gray";
  return (
    <Box
      key={idx}
      style={{
        fontFamily: "var(--code-font-family, monospace)",
        fontSize: "var(--font-size-1)",
        lineHeight: "var(--line-height-2)",
        background: color === "green" ? "var(--green-3)" : color === "red" ? "var(--red-3)" : "transparent",
        color: color === "gray" ? "var(--gray-11)" : undefined,
        padding: "0 var(--space-2)",
        whiteSpace: "pre",
        overflowX: "auto",
      }}
    >
      {line || " "}
    </Box>
  );
}

function DiffBody({ unifiedDiff }: { unifiedDiff: string }) {
  // Strip the createPatch header (lines starting with "Index:", "===", "---", "+++")
  const lines = unifiedDiff
    .split("\n")
    .filter((line) => !/^(Index:|=+$|---\s|\+\+\+\s)/.test(line));
  const truncated = lines.length > MAX_INLINE_DIFF_LINES;
  const shown = truncated ? lines.slice(0, MAX_INLINE_DIFF_LINES) : lines;
  return (
    <Box style={{ border: "1px solid var(--gray-5)", borderRadius: "var(--radius-2)", overflow: "hidden" }}>
      {shown.map(renderDiffLine)}
      {truncated ? (
        <Box style={{ padding: "var(--space-1) var(--space-2)", background: "var(--gray-3)" }}>
          <Text size="1" color="gray">
            +{lines.length - MAX_INLINE_DIFF_LINES} more lines — open in Spectrolite to view
          </Text>
        </Box>
      ) : null}
    </Box>
  );
}

export default function KbUserEditMessage({ state }: { state: KbUserEditState }) {
  if (!state || !state.path) {
    return (
      <Card>
        <Text size="1" color="gray">(empty kb.user_edit)</Text>
      </Card>
    );
  }
  const openHref = buildOpenLink(state);
  return (
    <Card>
      <Flex direction="column" gap="2">
        <Flex align="center" justify="between" gap="3" wrap="wrap">
          <Flex align="center" gap="2">
            <Pencil1Icon />
            <Code size="2">{state.path}</Code>
            <Badge color="green" variant="soft">+{state.addedLines}</Badge>
            <Badge color="red" variant="soft">−{state.removedLines}</Badge>
          </Flex>
          <Flex align="center" gap="2">
            {state.mentions.map((m) => (
              <Badge key={m} color="blue" variant="soft">@{m}</Badge>
            ))}
            <Link href={openHref} size="1">
              <Flex align="center" gap="1">
                <ExternalLinkIcon /> Open in Spectrolite
              </Flex>
            </Link>
          </Flex>
        </Flex>
        <DiffBody unifiedDiff={state.unifiedDiff} />
      </Flex>
    </Card>
  );
}

export function Pill({ state }: { state: KbUserEditState }) {
  if (!state || !state.path) return <Text size="1" color="gray">edit</Text>;
  const name = state.path.split("/").pop() ?? state.path;
  return (
    <Flex align="center" gap="2">
      <Pencil1Icon />
      <Text size="1" weight="medium">{name}</Text>
      <Text size="1" color="green">+{state.addedLines}</Text>
      <Text size="1" color="red">−{state.removedLines}</Text>
      {state.mentions.length > 0 ? (
        <Text size="1" color="blue">@{state.mentions.join(" @")}</Text>
      ) : null}
    </Flex>
  );
}

export const schema = {
  typeId: "kb.user_edit",
  fields: ["path", "unifiedDiff", "addedLines", "removedLines", "mentions", "at", "editorContextId"],
};
