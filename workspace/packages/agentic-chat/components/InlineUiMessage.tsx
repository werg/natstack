/**
 * InlineUiMessage - Renders compiled TSX inline in conversation flow.
 *
 * Collapsible card that stays in the chat history. Users can expand/collapse
 * at any time to interact with the component.
 */
import { Component, Suspense, useCallback, useEffect, useMemo, useReducer, useRef, useState, type ComponentType, type ReactNode } from "react";
import { Box, Button, Card, Callout, Flex, Spinner, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, ChevronDownIcon, ChevronUpIcon, ComponentInstanceIcon } from "@radix-ui/react-icons";
import type { InlineUiData } from "@natstack/pubsub";
import { useChatContext } from "../context/ChatContext";

/**
 * Error boundary for inline UI components.
 */
class InlineUiErrorBoundary extends Component<
  { children: ReactNode; resetKey?: string },
  { hasError: boolean; error?: Error }
> {
  constructor(props: { children: ReactNode; resetKey?: string }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error };
  }

  static getDerivedStateFromProps(
    props: { resetKey?: string },
    state: { hasError: boolean; prevResetKey?: string }
  ) {
    if (props.resetKey !== state.prevResetKey) {
      return { hasError: false, error: undefined, prevResetKey: props.resetKey };
    }
    return { prevResetKey: props.resetKey };
  }

  render() {
    if (this.state.hasError) {
      return (
        <Callout.Root color="red" size="1">
          <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
          <Callout.Text>
            <Text size="1">Component error: {this.state.error?.message || "Unknown error"}</Text>
          </Callout.Text>
        </Callout.Root>
      );
    }
    return this.props.children;
  }
}

interface InlineUiMessageProps {
  data: InlineUiData;
  compiledComponent?: ComponentType<{ props: Record<string, unknown>; chat: Record<string, unknown>; scope: Record<string, unknown>; scopes: Record<string, unknown> }>;
  compilationError?: string;
}

export function InlineUiMessage({ data, compiledComponent: CompiledComponent, compilationError }: InlineUiMessageProps) {
  const { chat, scope, scopes, scopeManager } = useChatContext();
  const componentProps = useMemo(() => data.props ?? {}, [data.props]);
  const [, forceUpdate] = useReducer((x: number) => x + 1, 0);

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
  const [autoCollapsed, setAutoCollapsed] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  // Auto-collapse if rendered content exceeds 400px
  const measuredRef = useCallback((node: HTMLDivElement | null) => {
    if (!node || autoCollapsed) return;
    // Use requestAnimationFrame to measure after paint
    requestAnimationFrame(() => {
      if (node.scrollHeight > 400) {
        setExpanded(false);
        setAutoCollapsed(true);
      }
    });
  }, [autoCollapsed]);

  if (compilationError) {
    return (
      <Callout.Root color="red" size="1">
        <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
        <Callout.Text>
          <Text size="1">Failed to render UI: {compilationError}</Text>
        </Callout.Text>
      </Callout.Root>
    );
  }

  if (!CompiledComponent) {
    return null;
  }

  const resetKey = JSON.stringify(data.props);

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
        <Box p="2" ref={measuredRef} onClickCapture={onInteraction} onInputCapture={onInteraction} onChangeCapture={onInteraction}>
          <InlineUiErrorBoundary resetKey={resetKey}>
            <Suspense fallback={<Spinner size="1" />}>
              <CompiledComponent props={componentProps} chat={chat as unknown as Record<string, unknown>} scope={scope} scopes={scopes as unknown as Record<string, unknown>} />
            </Suspense>
          </InlineUiErrorBoundary>
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
