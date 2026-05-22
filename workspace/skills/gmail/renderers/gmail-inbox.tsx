import { Badge, Button, Flex, Text } from "@radix-ui/themes";

interface GmailInboxState {
  unread: number;
  urgent: number;
  draftCount: number;
  perCategory?: Record<string, number>;
  lastSyncedAt?: string;
}

export function Pill({ state }: { state: GmailInboxState }) {
  return (
    <Flex align="center" gap="1">
      <Text size="1" weight="medium">Inbox</Text>
      <Text size="1" color="gray">{state.unread} unread</Text>
      {state.urgent > 0 ? <Badge size="1" color="red">{state.urgent} urgent</Badge> : null}
    </Flex>
  );
}

export default function GmailInbox({ state, expanded, chat }: {
  state: GmailInboxState;
  expanded: boolean;
  chat: { callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown> };
}) {
  if (!expanded) {
    return <Pill state={state} />;
  }

  return (
    <Flex direction="column" gap="2">
      <Flex gap="2" align="center" wrap="wrap">
        <Text size="3" weight="bold">Gmail inbox</Text>
        <Badge color="blue" variant="soft">{state.unread} unread</Badge>
        <Badge color="gray" variant="soft">{state.draftCount} drafts</Badge>
      </Flex>
      <Flex gap="1" wrap="wrap">
        {Object.entries(state.perCategory ?? {}).map(([name, count]) => (
          <Badge key={name} color="gray" variant="outline">{name}: {count}</Badge>
        ))}
      </Flex>
      <Flex gap="2">
        <Button size="1" onClick={() => chat.callMethodByHandle("gmail", "checkNow", {})}>Check now</Button>
        <Button size="1" variant="soft" onClick={() => chat.callMethodByHandle("gmail", "compose", {})}>Compose</Button>
      </Flex>
      {state.lastSyncedAt ? <Text size="1" color="gray">Last sync {state.lastSyncedAt}</Text> : null}
    </Flex>
  );
}
