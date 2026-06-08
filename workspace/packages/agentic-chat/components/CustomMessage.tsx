import React, { Suspense, useMemo, type ErrorInfo } from "react";
import { Badge, Box, Callout, Card, Flex, Spinner, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { EventErrorBoundary } from "@workspace/tool-ui/components/EventErrorBoundary";
import type { CustomMessageCardPayload } from "@workspace/agentic-core";
import { foldCustomMessageState, validateCustomState } from "@workspace/agentic-core";
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
  // Validate folded state against the registered schema (if any) before handing
  // it to the component. Surface a clear error instead of crashing the renderer.
  const validationErrors = useMemo(
    () => validateCustomState(entry.validator ?? entry.module.schema, state),
    [entry, state],
  );
  if (validationErrors) {
    return <CustomMessageValidationError typeId={payload.typeId} errors={validationErrors} compact={!expanded} />;
  }
  // Prefer a dedicated `Pill` export for the collapsed inline view; otherwise the
  // default component handles both states via `expanded`.
  const Component = (!expanded && entry.module.Pill) || entry.module.default;
  if (!Component) {
    return <Text size="1" color="blue" weight="medium">{payload.typeId}</Text>;
  }
  return (
    <Component
      messageId={payload.messageId}
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
  const reportError = (error: Error, info?: ErrorInfo) => {
    void publishCustomRenderFailed({ payload, entry, error, info, expanded, compact: true, chat });
  };
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
        onError={reportError}
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
  const reportError = (error: Error, info?: ErrorInfo) => {
    void publishCustomRenderFailed({ payload, entry, error, info, expanded, compact: false, chat });
  };
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
          onError={reportError}
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

async function publishCustomRenderFailed({
  payload,
  entry,
  error,
  info,
  expanded,
  compact,
  chat,
}: {
  payload: CustomMessageCardPayload;
  entry: Extract<MessageTypeComponentEntry, { status: "ready" }>;
  error: Error;
  info?: ErrorInfo;
  expanded: boolean;
  compact: boolean;
  chat: Record<string, unknown>;
}): Promise<void> {
  const publish = chat["publish"];
  if (typeof publish !== "function") return;
  const source = entry.definition.source;
  const sourcePath = source?.type === "file" ? source.path : undefined;
  try {
    await (publish as (kind: string, payload: unknown, options?: { idempotencyKey?: string }) => Promise<unknown>)(
      "custom.render_failed",
      {
        protocol: "agentic.trajectory.v1",
        typeId: payload.typeId,
        messageId: payload.messageId,
        displayMode: payload.displayMode,
        expanded,
        compact,
        lastSeq: payload.lastSeq,
        renderer: {
          source,
          sourcePath,
          cacheKey: entry.cacheKey,
          updatedAtSeq: entry.definition.updatedAtSeq,
        },
        error: {
          name: error.name || "Error",
          message: error.message || "Unknown error",
          stack: error.stack,
          componentStack: info?.componentStack,
        },
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : undefined,
        url: typeof location !== "undefined" ? location.href : undefined,
        createdAt: new Date().toISOString(),
      },
      {
        idempotencyKey: `custom:render-failed:${payload.messageId}:${payload.lastSeq}:${expanded ? "expanded" : "collapsed"}:${entry.cacheKey}`,
      },
    );
  } catch (publishError) {
    console.warn("Failed to publish custom.render_failed diagnostic", publishError);
  }
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

function CustomMessageValidationError({
  typeId,
  errors,
  compact = false,
}: {
  typeId: string;
  errors: string[];
  compact?: boolean;
}) {
  if (compact) {
    return (
      <Flex align="center" gap="1" title={errors.join("; ")}>
        <Badge color="amber" size="1">Invalid</Badge>
        <Text size="1" color="amber" weight="medium">{typeId}</Text>
      </Flex>
    );
  }
  return (
    <Callout.Root color="amber" size="1">
      <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
      <Text as="div" size="2" className="rt-CalloutText">
        <Flex direction="column" gap="1">
          <Text size="1" weight="medium">Invalid {typeId} state</Text>
          {errors.map((message, index) => (
            <Text key={index} size="1" color="amber">{message}</Text>
          ))}
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
