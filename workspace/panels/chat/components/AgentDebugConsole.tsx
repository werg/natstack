/**
 * Agent Debug Console
 *
 * Modal overlay showing agent's debug output (stdout/stderr, lifecycle events).
 * Opens from the participant badge dropdown menu.
 */

import { useRef, useEffect } from "react";
import { Box, Button, Dialog, Flex, ScrollArea, Text } from "@radix-ui/themes";
import type { AgentDebugPayload } from "@natstack/agentic-messaging";

export interface AgentDebugConsoleProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentHandle: string;
  debugEvents: Array<AgentDebugPayload & { ts: number }>;
}

/**
 * Render a single debug event line.
 */
function DebugEventLine({ event }: { event: AgentDebugPayload & { ts: number } }) {
  const time = new Date(event.ts).toLocaleTimeString();

  if (event.debugType === "lifecycle") {
    const isError = event.event === "stopped" && event.reason === "crash";
    const color = isError ? "red" : "gray";
    const reasonText = event.reason ? ` (${event.reason})` : "";
    return (
      <Text as="div" size="1" color={color} style={{ fontFamily: "monospace" }}>
        [{time}] {event.event.toUpperCase()}{reasonText}
      </Text>
    );
  }

  // Output event
  const color = event.stream === "stderr" ? "red" : "gray";
  return (
    <Text
      as="div"
      size="1"
      color={color}
      style={{ fontFamily: "monospace", whiteSpace: "pre-wrap", wordBreak: "break-word" }}
    >
      [{time}] {event.content}
    </Text>
  );
}

export function AgentDebugConsole({
  open,
  onOpenChange,
  agentHandle,
  debugEvents,
}: AgentDebugConsoleProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Filter events for this agent
  const agentEvents = debugEvents.filter((e) => e.handle === agentHandle);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [agentEvents.length]);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content style={{ maxWidth: 700, maxHeight: "80vh" }}>
        <Dialog.Title>Debug Console: @{agentHandle}</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="3">
          Agent stdout/stderr output and lifecycle events
        </Dialog.Description>

        <ScrollArea
          style={{ height: 400, background: "var(--gray-2)", borderRadius: "var(--radius-2)" }}
        >
          <Box p="2">
            {agentEvents.length === 0 ? (
              <Text size="2" color="gray">
                No debug output yet
              </Text>
            ) : (
              agentEvents.map((event, i) => (
                <DebugEventLine key={i} event={event} />
              ))
            )}
            <div ref={bottomRef} />
          </Box>
        </ScrollArea>

        <Flex justify="end" mt="3" gap="2">
          <Button variant="soft" color="gray" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
