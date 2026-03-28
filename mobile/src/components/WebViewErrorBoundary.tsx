/**
 * WebViewErrorBoundary -- Error boundary scoped to individual PanelWebView instances.
 *
 * If a single panel's WebView throws during render, this catches it and shows
 * a "Panel failed to load" screen with a reload button. Other panels continue
 * working normally. Uses static colors since theme atoms may be unavailable.
 */

import React, { type ErrorInfo, type ReactNode } from "react";
import { View, Text, Pressable, StyleSheet } from "react-native";

interface WebViewErrorBoundaryProps {
  children: ReactNode;
  /** Panel ID for logging */
  panelId: string;
}

interface WebViewErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class WebViewErrorBoundary extends React.Component<
  WebViewErrorBoundaryProps,
  WebViewErrorBoundaryState
> {
  constructor(props: WebViewErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): WebViewErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(
      `[WebViewErrorBoundary] Panel ${this.props.panelId} crashed:`,
      error,
      errorInfo.componentStack,
    );
  }

  private handleReload = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <View style={styles.container}>
          <Text style={styles.title}>Panel failed to load</Text>
          <Text style={styles.message}>
            {this.state.error?.message || "An unexpected error occurred."}
          </Text>
          <Pressable style={styles.reloadButton} onPress={this.handleReload}>
            <Text style={styles.reloadText}>Reload</Text>
          </Pressable>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
    backgroundColor: "#1a1a2e",
  },
  title: {
    fontSize: 18,
    fontWeight: "bold",
    color: "#e0e0e0",
    marginBottom: 8,
  },
  message: {
    fontSize: 14,
    color: "#888",
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 20,
  },
  reloadButton: {
    paddingHorizontal: 24,
    paddingVertical: 12,
    backgroundColor: "#0f3460",
    borderRadius: 8,
  },
  reloadText: {
    color: "#e0e0e0",
    fontSize: 16,
    fontWeight: "600",
  },
});
