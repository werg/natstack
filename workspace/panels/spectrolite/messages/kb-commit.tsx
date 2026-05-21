/**
 * Custom message type: `kb.commit`
 *
 * Published by Spectrolite after a manual commit. Pure log entry — observers
 * see a tidy card with subject + file list and can jump to the live doc.
 */

import { Badge, Card, Code, Flex, Link, Text } from "@radix-ui/themes";
import { CommitIcon, ExternalLinkIcon } from "@radix-ui/react-icons";
import { buildPanelLink, contextId as runtimeContextId } from "@workspace/runtime";

export interface KbCommitState {
  sha: string;
  subject: string;
  body: string;
  files: string[];
  at: number;
  editorContextId?: string;
}

function openLink(state: KbCommitState): string {
  return buildPanelLink("panels/spectrolite", {
    contextId: state.editorContextId ?? runtimeContextId ?? undefined,
    stateArgs: state.files[0] ? { openPath: state.files[0] } : {},
  });
}

export default function KbCommitMessage({ state }: { state: KbCommitState }) {
  if (!state || !state.sha) {
    return (
      <Card>
        <Text size="1" color="gray">(empty kb.commit)</Text>
      </Card>
    );
  }
  const short = state.sha.slice(0, 7);
  return (
    <Card>
      <Flex direction="column" gap="2">
        <Flex align="center" justify="between" gap="3" wrap="wrap">
          <Flex align="center" gap="2">
            <CommitIcon />
            <Code size="2">{short}</Code>
            <Text size="2" weight="medium">{state.subject}</Text>
          </Flex>
          <Link href={openLink(state)} size="1">
            <Flex align="center" gap="1">
              <ExternalLinkIcon /> Open in Spectrolite
            </Flex>
          </Link>
        </Flex>
        {state.body ? (
          <Text size="1" color="gray" style={{ whiteSpace: "pre-wrap" }}>{state.body}</Text>
        ) : null}
        <Flex gap="1" wrap="wrap">
          {state.files.map((f) => (
            <Badge key={f} variant="soft" color="gray">{f}</Badge>
          ))}
        </Flex>
      </Flex>
    </Card>
  );
}

export function Pill({ state }: { state: KbCommitState }) {
  if (!state || !state.sha) return <Text size="1" color="gray">commit</Text>;
  return (
    <Flex align="center" gap="2">
      <CommitIcon />
      <Code size="1">{state.sha.slice(0, 7)}</Code>
      <Text size="1">{state.subject}</Text>
    </Flex>
  );
}

export const schema = {
  typeId: "kb.commit",
  fields: ["sha", "subject", "body", "files", "at", "editorContextId"],
};
