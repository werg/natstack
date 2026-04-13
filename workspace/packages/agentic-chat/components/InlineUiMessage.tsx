/**
 * InlineUiMessage - Renders compiled TSX inline in conversation flow.
 *
 * Collapsible card that stays in the chat history. Users can expand/collapse
 * at any time to interact with the component.
 */
import { Suspense, useCallback, useEffect, useMemo, useReducer, useState, type ComponentType } from "react";
import { Box, Button, Card, Callout, Flex, Spinner, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, ChevronDownIcon, ChevronUpIcon, ComponentInstanceIcon } from "@radix-ui/react-icons";
import { EventErrorBoundary } from "@workspace/tool-ui/components/EventErrorBoundary";
import { wrapChatForErrorReporting, wrapScopesForErrorReporting } from "../utils/wrapSandboxApis";
import type { InlineUiData } from "@natstack/pubsub";
import type { ChatSandboxValue } from "@workspace/agentic-core";
import { useChatContext } from "../context/ChatContext";

// ---------------------------------------------------------------------------
// InlineUiErrorCallout — error display with "Report to Agent" button
// ---------------------------------------------------------------------------

function InlineUiErrorCallout({
  error,
  componentId,
  chat,
}: {
  error: Error;
  componentId: string;
  chat: ChatSandboxValue;
}) {
  const [reported, setReported] = useState(false);

  const handleReport = useCallback(() => {
    const message =
      `[Inline UI Error] Component "${componentId}" encountered an error ` +
      `during user interaction:\n\n\`\`\`\n${error.message}\n\`\`\`\n\n` +
      `${error.stack ? `Stack trace:\n\`\`\`\n${error.stack}\n\`\`\`` : ""}`;
    chat.publish("message", { content: message }).catch((err) => {
      console.error("[InlineUiMessage] Failed to report error to agent:", err);
    });
    setReported(true);
  }, [error, componentId, chat]);

  return (
    <Callout.Root color="red" size="1">
      <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
      <Callout.Text>
        <Flex direction="column" gap="2">
          <Text size="1">Component error: {error.message || "Unknown error"}</Text>
          <Box>
            <Button
              size="1"
              variant="soft"
              color="red"
              disabled={reported}
              onClick={handleReport}
            >
              {reported ? "Reported" : "Report to Agent"}
            </Button>
          </Box>
        </Flex>
      </Callout.Text>
    </Callout.Root>
  );
}

// ---------------------------------------------------------------------------
// InlineUiMessage
// ---------------------------------------------------------------------------

interface InlineUiMessageProps {
  data: InlineUiData;
  compiledComponent?: ComponentType<{ props: Record<string, unknown>; chat: Record<string, unknown>; scope: Record<string, unknown>; scopes: Record<string, unknown> }>;
  compilationError?: string;
}

export function InlineUiMessage({ data, compiledComponent: CompiledComponent, compilationError }: InlineUiMessageProps) {
  const { chat, scope, scopes, scopeManager } = useChatContext();
  const componentProps = useMemo(() => data.props ?? {}, [data.props]);
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);
  const [asyncError, setAsyncError] = useState<Error | null>(null);

  // Wrap chat/scopes so unhandled async rejections surface visually
  const onAsyncError = useCallback((err: Error) => setAsyncError(err), []);
  const wrappedChat = useMemo(
    () => wrapChatForErrorReporting(chat, onAsyncError),
    [chat, onAsyncError],
  );
  const wrappedScopes = useMemo(
    () => wrapScopesForErrorReporting(scopes, onAsyncError),
    [scopes, onAsyncError],
  );

  // Subscribe to scope changes — debounced re-render
  useEffect(() => {
    if (!scopeManager) return;
    let timer: ReturnType<typeof setTimeout>;
    return scopeManager.onChange(() => {
      clearTimeout(timer);
      timer = setTimeout(forceUpdate, 100);
    });
  }, [scopeManager]);

  // DOM event delegation — silent best-effort persist after user interaction
  const onInteraction = useCallback(() => scopeManager?.schedulePersist(2000), [scopeManager]);
  const [expanded, setExpanded] = useState(true);

  // Reset async error when props change (same trigger as EventErrorBoundary's resetKey)
  const resetKey = JSON.stringify(data.props);
  useEffect(() => { setAsyncError(null); }, [resetKey]);

  if (asyncError) {
    return <InlineUiErrorCallout error={asyncError} componentId={data.id} chat={chat} />;
  }

  if (compilationError) {
    return (
      <InlineUiErrorCallout
        error={new Error(compilationError)}
        componentId={data.id}
        chat={chat}
      />
    );
  }

  if (!CompiledComponent) {
    return null;
  }

  return (
    <Card
      variant="surface"
      size="1"
      style={{
        background: "var(--color-surface)",
        border: "1px solid var(--gray-a4)",
        overflow: "hidden",
      }}
    >
      {/* Clickable header — always visible */}
      <Flex
        align="center"
        gap="2"
        px="2"
        py="1"
        onClick={() => setExpanded(v => !v)}
        style={{
          cursor: "pointer",
          userSelect: "none",
          borderBottom: expanded ? "1px solid var(--gray-a4)" : "none",
        }}
      >
        <ComponentInstanceIcon style={{ color: "var(--gray-9)", flexShrink: 0 }} />
        <Text size="1" color="gray" style={{ flex: 1 }}>Interactive UI</Text>
        <Button variant="ghost" size="1" tabIndex={-1} style={{ pointerEvents: "none" }}>
          {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}
        </Button>
      </Flex>

      {/* Collapsible content */}
      {expanded && (
        <Box p="2" onClickCapture={onInteraction} onInputCapture={onInteraction} onChangeCapture={onInteraction}>
          <EventErrorBoundary
            resetKey={resetKey}
            renderFallback={(error) => (
              <InlineUiErrorCallout error={error} componentId={data.id} chat={chat} />
            )}
          >
            <Suspense fallback={<Spinner size="1" />}>
              <CompiledComponent props={componentProps} chat={wrappedChat as unknown as Record<string, unknown>} scope={scope} scopes={wrappedScopes as unknown as Record<string, unknown>} />
            </Suspense>
          </EventErrorBoundary>
        </Box>
      )}
    </Card>
  );
}

/**
 * Parse inline UI data from message content.
 * Returns null if parsing fails.
 */
export function parseInlineUiData(content: string): InlineUiData | null {
  try {
    return JSON.parse(content) as InlineUiData;
  } catch {
    return null;
  }
}
