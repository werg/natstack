import React from "react";
import { Box, Text } from "ink";
import type { PendingApproval } from "@natstack/shared/approvals";
import {
  parseApprovalMarkdown,
  type ApprovalMarkdownInline,
} from "@natstack/shared/approvalMarkdown";

export interface ApprovalsOverlayProps {
  pending: PendingApproval[];
  selectedIndex: number;
}

function summarize(a: PendingApproval): { title: string; detail: string } {
  const caller = a.callerTitle ?? a.callerId;
  switch (a.kind) {
    case "unit-batch":
      return { title: `Trust unit change · ${caller}`, detail: `version ${a.effectiveVersion}` };
    case "capability":
      return { title: `${a.title} · ${caller}`, detail: a.capability };
    case "credential":
      return { title: `Credential · ${a.credentialLabel}`, detail: caller };
    case "userland":
      return { title: `${a.title} · ${caller}`, detail: a.summary ?? "" };
    default:
      return { title: `${a.kind} · ${caller}`, detail: a.effectiveVersion ?? "" };
  }
}

/**
 * Host-owned, un-spoofable approvals overlay over the global shell queue. While
 * it's open the focused session's input is suspended and its output buffered,
 * so a worker cannot paint a fake prompt over it.
 */
export function ApprovalsOverlay({
  pending,
  selectedIndex,
}: ApprovalsOverlayProps): React.ReactElement {
  const current = pending[selectedIndex];
  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Text bold color="yellow">
        {`Approvals (${pending.length})`}
      </Text>
      {pending.length === 0 ? (
        <Text dimColor>Nothing pending. Esc to dismiss.</Text>
      ) : (
        <>
          {pending.map((a, i) => {
            const { title } = summarize(a);
            return (
              <Text key={a.approvalId} inverse={i === selectedIndex}>
                {`${i + 1}. ${title}`}
              </Text>
            );
          })}
          {current ? (
            <Box flexDirection="column" marginTop={1}>
              <ApprovalMarkdown source={summarize(current).detail} />
              <Text>
                {"[1] once  [2] session  [3] version  [4] repo  [5] deny  · ↑/↓ select · Esc dismiss"}
              </Text>
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
}

function ApprovalMarkdown({ source }: { source: string }): React.ReactElement | null {
  const blocks = parseApprovalMarkdown(source);
  if (blocks.length === 0) return null;
  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => {
        if (block.kind === "code-block") {
          return (
            <Box key={index} flexDirection="column" paddingLeft={1}>
              {block.text.split(/\r?\n/).map((line, lineIndex) => (
                <Text key={lineIndex} color="cyan">
                  {line || " "}
                </Text>
              ))}
            </Box>
          );
        }
        if (block.kind === "bullet-list" || block.kind === "ordered-list") {
          return (
            <Box key={index} flexDirection="column">
              {block.items.map((item, itemIndex) => (
                <Text key={itemIndex} dimColor>
                  {block.kind === "ordered-list" ? `${itemIndex + 1}. ` : "- "}
                  <ApprovalMarkdownInlineNodes nodes={item} />
                </Text>
              ))}
            </Box>
          );
        }
        return (
          <Text key={index} dimColor>
            <ApprovalMarkdownInlineNodes nodes={block.children} />
          </Text>
        );
      })}
    </Box>
  );
}

function ApprovalMarkdownInlineNodes({ nodes }: { nodes: ApprovalMarkdownInline[] }): React.ReactElement {
  return (
    <>
      {nodes.map((node, index) => {
        if (node.kind === "code") {
          return (
            <Text key={index} color="cyan">
              {node.text}
            </Text>
          );
        }
        if (node.kind === "strong") {
          return (
            <Text key={index} bold>
              <ApprovalMarkdownInlineNodes nodes={node.children} />
            </Text>
          );
        }
        if (node.kind === "emphasis") {
          return (
            <Text key={index}>
              <ApprovalMarkdownInlineNodes nodes={node.children} />
            </Text>
          );
        }
        return <React.Fragment key={index}>{node.text}</React.Fragment>;
      })}
    </>
  );
}
