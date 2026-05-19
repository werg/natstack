import { Button, Flex, Text } from "@radix-ui/themes";

export function NotificationCenter(props: {
  notifications: Array<{ notifId: string; sessionId: string; message: string; timestamp: number; read: boolean }>;
  onJump(sessionId: string): void;
  onMarkAllRead(): void;
}) {
  return (
    <Flex direction="column" width="260px" p="2" gap="2" style={{ borderLeft: "1px solid var(--gray-5)" }}>
      <Flex align="center" justify="between">
        <Text weight="medium" size="2">Notifications</Text>
        <Button size="1" variant="soft" onClick={props.onMarkAllRead}>Clear</Button>
      </Flex>
      <Flex direction="column" gap="1">
        {props.notifications.length === 0 ? <Text size="2" color="gray">No notifications</Text> : null}
        {props.notifications.map((item) => (
          <button
            key={item.notifId}
            onClick={() => props.onJump(item.sessionId)}
            style={{
              border: 0,
              borderRadius: 6,
              padding: 8,
              textAlign: "left",
              background: item.read ? "transparent" : "var(--accent-3)",
              color: "var(--gray-12)",
            }}
          >
            <Text size="2">{item.message}</Text>
            <br />
            <Text size="1" color="gray">{new Date(item.timestamp).toLocaleTimeString()}</Text>
          </button>
        ))}
      </Flex>
    </Flex>
  );
}
