/**
 * Shared loading/error state component for Monaco editor initialization.
 */
import { Flex, Spinner, Text, Button } from "@radix-ui/themes";

export interface MonacoLoadingStateProps {
  /** Loading message to display */
  message?: string;
  /** Error that occurred during initialization */
  error?: Error | null;
  /** Editor height (CSS value or number in pixels) */
  height?: number | string;
  /** Editor theme for background color matching */
  theme?: "vs-dark" | "light";
  /** Callback to retry loading */
  onRetry?: () => void;
}

/**
 * Loading/error state component for Monaco editor.
 * Displays a centered message with theme-appropriate styling.
 */
export function MonacoLoadingState({
  message = "Loading editor...",
  error,
  height,
  theme = "vs-dark",
  onRetry,
}: MonacoLoadingStateProps) {
  // Match Monaco's background colors exactly
  const backgroundColor = theme === "vs-dark" ? "#1e1e1e" : "#ffffff";

  return (
    <Flex
      align="center"
      justify="center"
      direction="column"
      gap="2"
      style={{
        width: "100%",
        height: typeof height === "number" ? `${height}px` : height ?? "100%",
        backgroundColor,
      }}
    >
      {error ? (
        <>
          <Text size="2" color="red">
            Failed to load editor
          </Text>
          <Text size="1" color="gray" align="center" style={{ maxWidth: "80%" }}>
            {error.message}
          </Text>
          {onRetry && (
            <Button size="1" variant="soft" color="gray" onClick={onRetry} mt="2">
              Retry
            </Button>
          )}
        </>
      ) : (
        <>
          <Spinner size="2" />
          <Text size="2" color="gray">
            {message}
          </Text>
        </>
      )}
    </Flex>
  );
}
