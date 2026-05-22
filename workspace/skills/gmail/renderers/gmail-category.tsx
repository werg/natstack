import { Badge, Flex, Text } from "@radix-ui/themes";

interface GmailCategoryThread {
  threadId: string;
  subject: string;
  unreadCount?: number;
}

interface GmailCategoryState {
  name: string;
  unread: number;
  threads?: GmailCategoryThread[];
}

export function Pill({ state }: { state: GmailCategoryState }) {
  return (
    <Flex align="center" gap="1">
      <Text size="1" weight="medium">{state.name}</Text>
      <Text size="1" color="gray">{state.unread} unread</Text>
    </Flex>
  );
}

export default function GmailCategory({ state, expanded }: {
  state: GmailCategoryState;
  expanded: boolean;
}) {
  if (!expanded) {
    return <Pill state={state} />;
  }

  return (
    <Flex direction="column" gap="2">
      <Flex align="center" gap="2">
        <Text size="3" weight="bold">{state.name}</Text>
        <Badge color="blue" variant="soft">{state.unread} unread</Badge>
      </Flex>
      <Flex direction="column" gap="1">
        {(state.threads ?? []).map((thread) => (
          <Flex key={thread.threadId} justify="between" gap="2">
            <Text size="2">{thread.subject}</Text>
            {thread.unreadCount ? <Text size="1" color="gray">{thread.unreadCount} unread</Text> : null}
          </Flex>
        ))}
      </Flex>
    </Flex>
  );
}
