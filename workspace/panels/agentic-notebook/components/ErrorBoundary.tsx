import { Component, type ReactNode, type ErrorInfo } from "react";
import { Box, Text, Button, Card, Code, Theme } from "@radix-ui/themes";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Fallback UI to show when an error occurs */
  fallback?: ReactNode;
  /** Called when an error is caught */
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Component name for error reporting */
  componentName?: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

/**
 * ErrorBoundary - Catches JavaScript errors in child component tree.
 *
 * Prevents the entire app from crashing when a component throws an error.
 * Displays a fallback UI and optionally reports the error.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorInfo: null,
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    this.setState({ errorInfo });

    // Call the onError callback if provided
    if (this.props.onError) {
      this.props.onError(error, errorInfo);
    }

    // Log to console for debugging
    console.error(
      `[ErrorBoundary${this.props.componentName ? `: ${this.props.componentName}` : ""}]`,
      error,
      errorInfo.componentStack
    );
  }

  handleReset = (): void => {
    this.setState({
      hasError: false,
      error: null,
      errorInfo: null,
    });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      // If a custom fallback is provided, use it
      if (this.props.fallback) {
        return this.props.fallback;
      }

      // Default fallback UI - wrapped in Theme to ensure Radix components render properly
      return (
        <Theme accentColor="red" grayColor="slate" radius="medium">
          <Card
            variant="surface"
            style={{
              background: "var(--red-a2)",
              border: "1px solid var(--red-6)",
              padding: "16px",
              margin: "8px",
            }}
          >
            <Box mb="3">
              <Text size="3" weight="medium" color="red">
                Something went wrong
                {this.props.componentName && ` in ${this.props.componentName}`}
              </Text>
            </Box>

            {this.state.error && (
              <Box
                mb="3"
                style={{
                  background: "var(--red-a3)",
                  borderRadius: "var(--radius-2)",
                  padding: "8px",
                  overflow: "auto",
                  maxHeight: "150px",
                }}
              >
                <Code size="1" color="red" style={{ whiteSpace: "pre-wrap" }}>
                  {this.state.error.message}
                </Code>
              </Box>
            )}

            {this.state.errorInfo && (
              <Box
                mb="3"
                style={{
                  background: "var(--gray-a3)",
                  borderRadius: "var(--radius-2)",
                  padding: "8px",
                  overflow: "auto",
                  maxHeight: "200px",
                }}
              >
                <Text size="1" color="gray" mb="1">
                  Component Stack:
                </Text>
                <Code
                  size="1"
                  style={{
                    whiteSpace: "pre-wrap",
                    display: "block",
                    fontSize: "10px",
                  }}
                >
                  {this.state.errorInfo.componentStack}
                </Code>
              </Box>
            )}

            <Button size="1" variant="soft" color="red" onClick={this.handleReset}>
              Try Again
            </Button>
          </Card>
        </Theme>
      );
    }

    return this.props.children;
  }
}

/**
 * Higher-order component for wrapping components with an error boundary.
 */
export function withErrorBoundary<P extends object>(
  WrappedComponent: React.ComponentType<P>,
  componentName?: string
): React.FC<P & { onError?: (error: Error, errorInfo: ErrorInfo) => void }> {
  const WithErrorBoundary: React.FC<
    P & { onError?: (error: Error, errorInfo: ErrorInfo) => void }
  > = (props) => {
    const { onError, ...rest } = props;
    return (
      <ErrorBoundary componentName={componentName} onError={onError}>
        <WrappedComponent {...(rest as P)} />
      </ErrorBoundary>
    );
  };

  WithErrorBoundary.displayName = `WithErrorBoundary(${componentName || WrappedComponent.displayName || WrappedComponent.name || "Component"})`;

  return WithErrorBoundary;
}
