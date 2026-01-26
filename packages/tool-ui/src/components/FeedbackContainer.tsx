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
  /** Initial/default height (default: 50% of viewport height) */
  defaultHeight?: number;
  /** Minimum height when resizing (default: 150px) */
  minHeight?: number;
  /** Maximum height when resizing (default: 70% of viewport height) */
  maxHeight?: number;
}

const getViewportHeight = () =>
  typeof window !== "undefined" ? window.innerHeight : 800;

export function FeedbackContainer({
  children,
  onDismiss,
  onError,
  defaultHeight: defaultHeightProp,
  minHeight = 150,
  maxHeight: maxHeightProp,
}: FeedbackContainerProps) {
  const [viewportHeight, setViewportHeight] = useState(getViewportHeight);
  const maxHeight = maxHeightProp ?? Math.floor(viewportHeight * 0.7);

  const [height, setHeight] = useState(
    () => defaultHeightProp ?? Math.floor(getViewportHeight() * 0.5)
  );
  const [isDragging, setIsDragging] = useState(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);

  // Track viewport height and clamp current height if needed
  useEffect(() => {
    const handleResize = () => {
      const vh = window.innerHeight;
      setViewportHeight(vh);
      const newMax = maxHeightProp ?? Math.floor(vh * 0.7);
      setHeight((h) => Math.min(h, newMax));
    };
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [maxHeightProp]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragStartY.current = e.clientY;
    dragStartHeight.current = height;
  }, [height]);

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
        height,
        minHeight,
        maxHeight,
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

      {/* Scrollable content */}
      <Box p="3" flexGrow="1" style={{ minHeight: 0, overflow: "hidden" }}>
        <ScrollArea style={{ height: "100%" }}>
          <ErrorBoundary onError={onError}>{children}</ErrorBoundary>
        </ScrollArea>
      </Box>
    </Card>
  );
}
