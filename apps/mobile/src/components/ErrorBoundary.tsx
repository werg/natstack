/**
 * ErrorBoundary -- Top-level error boundary for the NatStack mobile app.
 *
 * Catches unhandled React render errors and shows a recovery screen
 * instead of crashing the entire app. Uses static colors since Jotai
 * atoms may not be available in the error state.
 */

import React, { type ErrorInfo, type ReactNode } from "react";
import { View, Text, Pressable, ScrollView, StyleSheet } from "react-native";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional label shown in the error screen (e.g. "App" or "Panel") */
  label?: string;
  /** Optional color overrides for theming the error screen */
  colors?: {
    background?: string;
    text?: string;
    textSecondary?: string;
    accent?: string;
    accentText?: string;
  };
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends React.Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error(
      `[ErrorBoundary${this.props.label ? `:${this.props.label}` : ""}] Uncaught error:`,
      error,
      errorInfo.componentStack,
    );
  }

  private handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      const { error } = this.state;
      const label = this.props.label ?? "App";
      const colors = this.props.colors;

      return (
        <View style={[styles.container, colors?.background != null && { backgroundColor: colors.background }]}>
          <View style={styles.content}>
            <Text style={[styles.title, colors?.text != null && { color: colors.text }]}>Something went wrong</Text>
            <Text style={[styles.message, colors?.textSecondary != null && { color: colors.textSecondary }]}>
              {label} encountered an unexpected error.
            </Text>
            {error?.message ? (
              <Text style={styles.errorMessage}>{error.message}</Text>
            ) : null}

            <Pressable style={[styles.retryButton, colors?.accent != null && { backgroundColor: colors.accent }]} onPress={this.handleRetry}>
              <Text style={[styles.retryText, colors?.accentText != null && { color: colors.accentText }]}>Retry</Text>
            </Pressable>

            {__DEV__ && error?.stack ? (
              <ScrollView style={styles.stackContainer}>
                <Text style={styles.stackText}>{error.stack}</Text>
              </ScrollView>
            ) : null}
          </View>
        </View>
      );
    }

    return this.props.children;
  }
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#1a1a2e",
    justifyContent: "center",
    alignItems: "center",
  },
  content: {
    padding: 32,
    alignItems: "center",
    maxWidth: 400,
  },
  title: {
    fontSize: 20,
    fontWeight: "bold",
    color: "#e0e0e0",
    marginBottom: 12,
    textAlign: "center",
  },
  message: {
    fontSize: 15,
    color: "#999",
    textAlign: "center",
    marginBottom: 8,
    lineHeight: 22,
  },
  errorMessage: {
    fontSize: 13,
    color: "#cc6666",
    textAlign: "center",
    marginBottom: 24,
    lineHeight: 20,
  },
  retryButton: {
    paddingHorizontal: 32,
    paddingVertical: 14,
    backgroundColor: "#0f3460",
    borderRadius: 8,
    marginBottom: 24,
  },
  retryText: {
    color: "#e0e0e0",
    fontSize: 16,
    fontWeight: "600",
  },
  stackContainer: {
    maxHeight: 200,
    width: "100%",
    backgroundColor: "#111122",
    borderRadius: 8,
    padding: 12,
  },
  stackText: {
    fontSize: 11,
    color: "#888",
    fontFamily: "monospace",
  },
});
