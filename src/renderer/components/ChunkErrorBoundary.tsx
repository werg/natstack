import { Component, type ReactNode, type ErrorInfo } from "react";
import { Flex, Text, Button } from "@radix-ui/themes";

interface Props {
  children: ReactNode;
  /** Called before re-rendering children — use to reset cached lazy components. */
  onRetry?: () => void;
}

interface State {
  error: Error | null;
}

/**
 * Error boundary for lazy-loaded chunks.
 * Shows a retry button when a chunk fails to load (e.g., network error, stale cache).
 *
 * Important: React.lazy caches rejected promises permanently, so callers must
 * pass an `onRetry` callback that reassigns the lazy component to get a fresh
 * import() attempt.
 */
export class ChunkErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ChunkErrorBoundary] Failed to load chunk:", error, info.componentStack);
  }

  handleRetry = () => {
    this.props.onRetry?.();
    this.setState({ error: null });
  };

  render() {
    if (this.state.error) {
      return (
        <Flex direction="column" align="center" justify="center" gap="3" style={{ height: "100vh" }}>
          <Text size="3" weight="medium" color="red">
            Failed to load application
          </Text>
          <Text size="2" color="gray">
            {this.state.error.message}
          </Text>
          <Button variant="soft" onClick={this.handleRetry}>
            Retry
          </Button>
        </Flex>
      );
    }

    return this.props.children;
  }
}
