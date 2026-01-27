/**
 * InlineUiMessage - Renders compiled MDX inline in conversation flow.
 * Unlike feedback components, these are display-only (no interaction callbacks).
 */
import { Component, Suspense, useMemo, type ComponentType, type ReactNode } from "react";
import { Box, Callout, Spinner, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import type { InlineUiData } from "@natstack/agentic-messaging";

/**
 * Error boundary for inline UI components.
 * Catches render errors and displays a friendly message.
 * Resets when the resetKey prop changes (allows recovery on updates).
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
    // Reset error state when resetKey changes (e.g., new props from update)
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
  compiledComponent?: ComponentType<{ props: Record<string, unknown> }>;
  compilationError?: string;
}

export function InlineUiMessage({ data, compiledComponent: Component, compilationError }: InlineUiMessageProps) {
  // Memoize props to prevent unnecessary re-renders
  const componentProps = useMemo(() => data.props ?? {}, [data.props]);

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

  if (!Component) {
    // No compiled component - likely an ephemeral message that shouldn't be shown
    // after page refresh. Return null to hide it.
    return null;
  }

  // Use stringified props as reset key so error boundary resets on updates
  const resetKey = JSON.stringify(data.props);

  return (
    <InlineUiErrorBoundary resetKey={resetKey}>
      <Suspense fallback={<Spinner size="1" />}>
        <Component props={componentProps} />
      </Suspense>
    </InlineUiErrorBoundary>
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
