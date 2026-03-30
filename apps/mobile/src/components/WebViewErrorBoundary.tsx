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
  /** Optional color overrides for theming the error screen */
  colors?: {
    background?: string;
    text?: string;
    textSecondary?: string;
    accent?: string;
    accentText?: string;
  };
}

interface WebViewErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  resetKey: number;
}

export class WebViewErrorBoundary extends React.Component<
  WebViewErrorBoundaryProps,
  WebViewErrorBoundaryState
> {
  constructor(props: WebViewErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, resetKey: 0 };
  }

  static getDerivedStateFromError(error: Error): Partial<WebViewErrorBoundaryState> {
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
    this.setState(prev => ({ hasError: false, error: null, resetKey: (prev.resetKey ?? 0) + 1 }));
  };

  render() {
    if (this.state.hasError) {
      const colors = this.props.colors;
      return (
        <View style={[styles.container, colors?.background != null && { backgroundColor: colors.background }]}>
          <Text style={[styles.title, colors?.text != null && { color: colors.text }]}>Panel failed to load</Text>
          <Text style={[styles.message, colors?.textSecondary != null && { color: colors.textSecondary }]}>
            {this.state.error?.message || "An unexpected error occurred."}
          </Text>
          <Pressable style={[styles.reloadButton, colors?.accent != null && { backgroundColor: colors.accent }]} onPress={this.handleReload}>
            <Text style={[styles.reloadText, colors?.accentText != null && { color: colors.accentText }]}>Reload</Text>
          </Pressable>
        </View>
      );
    }

    return <View key={this.state.resetKey} style={{ flex: 1 }}>{this.props.children}</View>;
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
