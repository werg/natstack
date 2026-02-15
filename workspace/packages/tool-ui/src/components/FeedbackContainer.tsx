/**
 * FeedbackContainer - Wrapper for feedback UI components.
 *
 * Provides error boundary, dismiss button, consistent styling,
 * draggable top edge for resizing, and scrollable content area.
 */

import { Box, Button, Card, Flex, ScrollArea, Text } from "@radix-ui/themes";
import { Cross2Icon, DragHandleHorizontalIcon } from "@radix-ui/react-icons";
import { type ReactNode, useState, useCallback, useRef, useEffect } from "react";
import { ErrorBoundary } from "./ErrorBoundary";

export interface FeedbackContainerProps {
  /** The feedback component to render */
  children: ReactNode;
  /** Called when user clicks the X button */
  onDismiss: () => void;
  /** Called when the component throws during render */
  onError: (error: Error) => void;
  /** Title displayed in the container header (default: "Agent requires input") */
  title?: string;
  /** Initial/default height (default: 50% of available container height) */
  defaultHeight?: number;
  /** Minimum height when resizing (default: 150px) */
  minHeight?: number;
  /** Maximum height when resizing (default: 70% of available container height) */
  maxHeight?: number;
}

const getViewportHeight = () =>
  typeof window !== "undefined" ? window.innerHeight : 800;

export function FeedbackContainer({
  children,
  onDismiss,
  onError,
  title = "Agent requires input",
  defaultHeight: defaultHeightProp,
  minHeight = 150,
  maxHeight: maxHeightProp,
}: FeedbackContainerProps) {
  const [viewportHeight, setViewportHeight] = useState(getViewportHeight);

  // Track viewport height changes
  useEffect(() => {
    const handleResize = () => setViewportHeight(window.innerHeight);
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Calculate limits based on viewport - use high percentages since
  // the flex layout will naturally constrain growth
  const maxHeight = maxHeightProp ?? Math.floor(viewportHeight * 0.7);
  const defaultHeight = defaultHeightProp ?? Math.min(Math.floor(viewportHeight * 0.5), maxHeight);

  const [height, setHeight] = useState<number | null>(null);
  const effectiveHeight = height ?? defaultHeight;

  const [isDragging, setIsDragging] = useState(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

  // Clamp height when viewport shrinks
  useEffect(() => {
    if (height !== null && height > maxHeight) {
      setHeight(maxHeight);
    }
  }, [height, maxHeight]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartY.current = e.clientY;
    dragStartHeight.current = effectiveHeight;
  }, [effectiveHeight]);

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      // Dragging up (negative deltaY) should increase height
      const deltaY = dragStartY.current - e.clientY;
      const newHeight = Math.min(maxHeight, Math.max(minHeight, dragStartHeight.current + deltaY));
      setHeight(newHeight);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isDragging, minHeight, maxHeight]);

  return (
    <Card
      variant="surface"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        height: effectiveHeight,
        minHeight,
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {/* Drag handle at top edge */}
      <Box
        onMouseDown={handleMouseDown}
        style={{
          height: 8,
          cursor: "ns-resize",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: isDragging ? "var(--gray-5)" : "var(--gray-4)",
          borderBottom: "1px solid var(--gray-5)",
          flexShrink: 0,
          userSelect: "none",
        }}
      >
        <DragHandleHorizontalIcon style={{ color: "var(--gray-9)", width: 16, height: 16 }} />
      </Box>

      {/* Header */}
      <Flex
        justify="between"
        align="center"
        p="2"
        flexShrink="0"
        style={{ borderBottom: "1px solid var(--gray-5)" }}
      >
        <Text size="2" weight="bold">
          {title}
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

      {/* Scrollable content */}
      <Box p="3" flexGrow="1" style={{ minHeight: 0, overflow: "hidden" }}>
        <ScrollArea style={{ height: "100%" }}>
          <ErrorBoundary onError={onError}>{children}</ErrorBoundary>
        </ScrollArea>
      </Box>
    </Card>
  );
}
