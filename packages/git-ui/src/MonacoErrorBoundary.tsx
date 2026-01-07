import { Component, type ReactNode } from "react";
import { Box, Text, Button, Callout } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";

interface Props {
  children: ReactNode;
  fallbackHeight?: number | string;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

/**
 * Error boundary for Monaco Editor components.
 * Catches errors during render and provides a recovery UI.
 */
export class MonacoErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("Monaco Editor error:", error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <Box
          p="4"
          style={{
            height: this.props.fallbackHeight ?? 200,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <Callout.Root color="red" size="1">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>
              <Text size="2">Failed to load editor</Text>
              {this.state.error && (
                <Text size="1" color="gray" as="p">
                  {this.state.error.message}
                </Text>
              )}
              <Button size="1" variant="soft" onClick={this.handleRetry} mt="2">
                Retry
              </Button>
            </Callout.Text>
          </Callout.Root>
        </Box>
      );
    }

    return this.props.children;
  }
}
