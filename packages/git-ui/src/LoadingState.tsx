import type { ComponentProps } from "react";
import { Flex, Spinner, Text } from "@radix-ui/themes";

export interface LoadingStateProps {
  /** Optional message to display */
  message?: string;
  /** Size of the spinner (default: "2") */
  size?: "1" | "2" | "3";
  /** Fill available height (useful for page-level loading) */
  fullHeight?: boolean;
  /** Vertical padding when not fullHeight (default: "4") */
  py?: ComponentProps<typeof Flex>["py"];
}

/**
 * Centered loading spinner with optional message.
 * Use `fullHeight` for page-level loading states.
 */
export function LoadingState({
  message,
  size = "2",
  fullHeight = false,
  py = "4",
}: LoadingStateProps) {
  return (
    <Flex
      align="center"
      justify="center"
      gap="2"
      height={fullHeight ? "100%" : undefined}
      py={fullHeight ? undefined : py}
    >
      <Spinner size={size} />
      {message && (
        <Text size="2" color="gray">
          {message}
        </Text>
      )}
    </Flex>
  );
}
