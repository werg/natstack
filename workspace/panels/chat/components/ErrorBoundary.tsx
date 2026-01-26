import React, { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: React.ErrorInfo) => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

/**
 * Error boundary component to catch React rendering errors and prevent
 * the entire app from unmounting. Shows an error UI instead of a blank page.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("[Chat ErrorBoundary] React error caught:", error);
    console.error("[Chat ErrorBoundary] Component stack:", errorInfo.componentStack);

    this.setState({ errorInfo });
    this.props.onError?.(error, errorInfo);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: null });
  };

  render(): ReactNode {
    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          style={{
            padding: "20px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            backgroundColor: "var(--background, #1a1a1a)",
            color: "var(--foreground, #e0e0e0)",
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          <div
            style={{
              maxWidth: "500px",
              textAlign: "center",
            }}
          >
            <h2 style={{ color: "var(--error, #f44336)", marginBottom: "16px" }}>
              Something went wrong
            </h2>
            <p style={{ marginBottom: "16px", opacity: 0.8 }}>
              The chat panel encountered an error. You can try to recover or reload the panel.
            </p>
            <details
              style={{
                marginBottom: "16px",
                textAlign: "left",
                backgroundColor: "var(--surface, #2a2a2a)",
                padding: "12px",
                borderRadius: "8px",
                fontSize: "12px",
              }}
            >
              <summary style={{ cursor: "pointer", marginBottom: "8px" }}>
                Error details
              </summary>
              <pre
                style={{
                  overflow: "auto",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  margin: 0,
                  color: "var(--error, #f44336)",
                }}
              >
                {this.state.error?.toString()}
              </pre>
              {this.state.errorInfo?.componentStack && (
                <pre
                  style={{
                    overflow: "auto",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    margin: "8px 0 0 0",
                    opacity: 0.7,
                    fontSize: "10px",
                  }}
                >
                  {this.state.errorInfo.componentStack}
                </pre>
              )}
            </details>
            <div style={{ display: "flex", gap: "12px", justifyContent: "center" }}>
              <button
                onClick={this.handleRetry}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "var(--primary, #4a9eff)",
                  color: "white",
                  border: "none",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                Try Again
              </button>
              <button
                onClick={() => window.location.reload()}
                style={{
                  padding: "8px 16px",
                  backgroundColor: "var(--surface, #3a3a3a)",
                  color: "var(--foreground, #e0e0e0)",
                  border: "1px solid var(--border, #444)",
                  borderRadius: "6px",
                  cursor: "pointer",
                  fontSize: "14px",
                }}
              >
                Reload Panel
              </button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
