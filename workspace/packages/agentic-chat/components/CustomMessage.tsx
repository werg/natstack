import React, { Suspense, useMemo } from "react";
import { Badge, Box, Callout, Card, Flex, Spinner, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { EventErrorBoundary } from "@workspace/tool-ui/components/EventErrorBoundary";
import type { CustomMessageCardPayload } from "@workspace/agentic-core";
import { foldCustomMessageState } from "@workspace/agentic-core";
import type { MessageTypeComponentEntry } from "../types";

interface CustomRenderProps {
  payload: CustomMessageCardPayload;
  entry?: MessageTypeComponentEntry;
  chat: Record<string, unknown>;
  scope: Record<string, unknown>;
  scopes: Record<string, unknown>;
}

interface ReadyCustomRenderProps extends CustomRenderProps {
  entry: Extract<MessageTypeComponentEntry, { status: "ready" }>;
  expanded: boolean;
}

function useFoldedState(payload: CustomMessageCardPayload, entry?: MessageTypeComponentEntry): unknown {
  return useMemo(() => {
    if (entry?.status !== "ready") return payload.initialState;
    return foldCustomMessageState(payload.initialState, payload.updates, entry.module.reduce);
  }, [entry, payload.initialState, payload.lastSeq, payload.updates]);
}

function CustomRenderer({
  payload,
  entry,
  expanded,
  chat,
  scope,
  scopes,
}: ReadyCustomRenderProps) {
  const state = useFoldedState(payload, entry);
  const Component = entry.module.default;
  if (!Component) {
    return <Text size="1" color="blue" weight="medium">{payload.typeId}</Text>;
  }
  return (
    <Component
      typeId={payload.typeId}
      state={state}
      expanded={expanded}
      displayMode={payload.displayMode}
      chat={chat}
      scope={scope}
      scopes={scopes}
    />
  );
}

export const CustomPill = React.memo(function CustomPill({
  id,
  payload,
  entry,
  expanded,
  chat,
  scope,
  scopes,
  onExpand,
}: CustomRenderProps & {
  id: string;
  expanded: boolean;
  onExpand: (id: string) => void;
}) {
  if (!entry || entry.status === "loading") {
    return (
      <Flex align="center" gap="1" style={pillStyle("gray")} title={payload.typeId}>
        <Spinner size="1" />
        <Text size="1" color="gray" weight="medium">{payload.typeId}</Text>
      </Flex>
    );
  }
  if (entry.status === "error") {
    return (
      <Flex align="center" gap="1" style={pillStyle("red")} title={entry.message}>
        <Text size="1" color="red" weight="medium">{payload.typeId}</Text>
      </Flex>
    );
  }
  const resetKey = customResetKey(payload, entry, expanded);
  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onExpand(id);
  };
  return (
    <Flex
      align="center"
      gap="1"
      style={pillStyle("blue")}
      onClick={() => onExpand(id)}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-expanded={expanded}
    >
      <EventErrorBoundary
        resetKey={resetKey}
        renderFallback={(error) => <CustomMessageErrorFallback error={error} typeId={payload.typeId} compact />}
      >
        <Suspense fallback={<Spinner size="1" />}>
          <CustomRenderer
            payload={payload}
            entry={entry}
            expanded={expanded}
            chat={chat}
            scope={scope}
            scopes={scopes}
          />
        </Suspense>
      </EventErrorBoundary>
    </Flex>
  );
});

export const ExpandedCustom = React.memo(function ExpandedCustom({
  payload,
  entry,
  expanded,
  chat,
  scope,
  scopes,
  onCollapse,
}: CustomRenderProps & {
  expanded: boolean;
  onCollapse?: () => void;
}) {
  if (!entry || entry.status === "loading") {
    return <CustomPlaceholder typeId={payload.typeId} status="loading" />;
  }
  if (entry.status === "error") {
    return <CustomPlaceholder typeId={payload.typeId} status="error" message={entry.message} />;
  }
  const Component = entry.module.default;
  if (!Component) {
    return <CustomPlaceholder typeId={payload.typeId} status="error" message="Message type has no default export" />;
  }
  const resetKey = customResetKey(payload, entry, expanded);
  return (
    <Card className="message-card">
      {onCollapse && (
        <Flex
          align="center"
          justify="between"
          mb="2"
          onClick={onCollapse}
          tabIndex={0}
          style={{ cursor: "pointer", userSelect: "none" }}
        >
          <Text size="1" color="gray" weight="medium">{payload.typeId}</Text>
          <Text size="1" color="gray">Collapse</Text>
        </Flex>
      )}
      <Box>
        <EventErrorBoundary
          resetKey={resetKey}
          renderFallback={(error) => <CustomMessageErrorFallback error={error} typeId={payload.typeId} />}
        >
          <Suspense fallback={<Spinner size="1" />}>
            <CustomRenderer
              payload={payload}
              entry={entry}
              expanded={expanded}
              chat={chat}
              scope={scope}
              scopes={scopes}
            />
          </Suspense>
        </EventErrorBoundary>
      </Box>
    </Card>
  );
});

export function CustomMessageCard(props: CustomRenderProps) {
  return <ExpandedCustom {...props} expanded={true} />;
}

function CustomPlaceholder({
  typeId,
  status,
  message,
}: {
  typeId: string;
  status: "loading" | "error";
  message?: string;
}) {
  return (
    <Card className="message-card">
      <Flex direction="column" gap="2">
        <Flex align="center" gap="2">
          {status === "loading" ? <Spinner size="1" /> : <Badge color="red" size="1">Custom type</Badge>}
          <Text size="2" weight="medium">{typeId}</Text>
        </Flex>
        {message && <Text size="1" color="red">{message}</Text>}
      </Flex>
    </Card>
  );
}

function CustomMessageErrorFallback({
  error,
  typeId,
  compact = false,
}: {
  error: Error;
  typeId: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Flex align="center" gap="1" title={error.message}>
        <Badge color="red" size="1">Error</Badge>
        <Text size="1" color="red" weight="medium">{typeId}</Text>
      </Flex>
    );
  }
  return (
    <Callout.Root color="red" size="1">
      <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
      <Text as="div" size="2" className="rt-CalloutText">
        <Flex direction="column" gap="1">
          <Text size="1" weight="medium">Custom message error: {typeId}</Text>
          <Text size="1" color="red">{error.message || "Unknown error"}</Text>
        </Flex>
      </Text>
    </Callout.Root>
  );
}

function customResetKey(
  payload: CustomMessageCardPayload,
  entry: Extract<MessageTypeComponentEntry, { status: "ready" }>,
  expanded: boolean,
): string {
  return `${entry.cacheKey}:${payload.messageId}:${payload.lastSeq}:${expanded ? "expanded" : "collapsed"}`;
}

function pillStyle(color: "blue" | "gray" | "red"): React.CSSProperties {
  return {
    cursor: color === "gray" ? "default" : "pointer",
    userSelect: "none",
    padding: "2px 6px",
    borderRadius: "4px",
    backgroundColor: `var(--${color}-a3)`,
    border: `1px solid var(--${color}-a5)`,
  };
}
