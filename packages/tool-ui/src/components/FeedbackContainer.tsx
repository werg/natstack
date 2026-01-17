/**
 * FeedbackContainer - Wrapper for feedback UI components.
 *
 * Provides error boundary, dismiss button, and consistent styling.
 */

import { Box, Button, Card, Flex, Text } from "@radix-ui/themes";
import { Cross2Icon } from "@radix-ui/react-icons";
import type { ReactNode } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

export interface FeedbackContainerProps {
  /** The feedback component to render */
  children: ReactNode;
  /** Called when user clicks the X button */
  onDismiss: () => void;
  /** Called when the component throws during render */
  onError: (error: Error) => void;
}

export function FeedbackContainer({
  children,
  onDismiss,
  onError,
}: FeedbackContainerProps) {
  return (
    <Card variant="surface" style={{ position: "relative" }}>
      <Flex
        justify="between"
        align="center"
        p="2"
        style={{ borderBottom: "1px solid var(--gray-5)" }}
      >
        <Text size="2" weight="bold">
          Agent requires input
        </Text>
        <Button
          variant="ghost"
          size="1"
          onClick={onDismiss}
          style={{ cursor: "pointer" }}
        >
          <Cross2Icon />
        </Button>
      </Flex>
      <Box p="3">
        <ErrorBoundary onError={onError}>{children}</ErrorBoundary>
      </Box>
    </Card>
  );
}
