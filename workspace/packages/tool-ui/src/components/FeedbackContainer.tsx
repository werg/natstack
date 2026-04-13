/**
 * FeedbackContainer - Wrapper for feedback UI components.
 *
 * Sizes to content naturally with a max-height cap. Provides error boundary,
 * dismiss button, consistent styling, and scrollable content area.
 * Draggable top edge for manual resizing when needed.
 */

import { Box, Button, Card, Flex, ScrollArea, Text } from "@radix-ui/themes";
import { Cross2Icon, DragHandleHorizontalIcon } from "@radix-ui/react-icons";
import { type ReactNode, useState, useCallback, useRef, useEffect } from "react";
import { useViewportHeight } from "@workspace/react";
import { EventErrorBoundary } from "./EventErrorBoundary";

export interface FeedbackContainerProps {
  /** The feedback component to render */
  children: ReactNode;
  /** Called when user clicks the X button */
  onDismiss: () => void;
  /** Called when the component throws during render */
  onError: (error: Error) => void;
  /** Title displayed in the container header (default: "Agent requires input") */
  title?: string;
  /** Maximum height as fraction of viewport (default: 0.5) */
  maxHeightFraction?: number;
  /** Minimum height when resizing (default: 100px) */
  minHeight?: number;
}

export function FeedbackContainer({
  children,
  onDismiss,
  onError,
  title = "Agent requires input",
  maxHeightFraction = 0.5,
  minHeight = 100,
}: FeedbackContainerProps) {
  // Manual height override (null = auto/content-fit)
  const [manualHeight, setManualHeight] = useState<number | null>(null);

  const [isDragging, setIsDragging] = useState(false);
  const dragStartY = useRef(0);
  const dragStartHeight = useRef(0);
  const cardRef = useRef<HTMLDivElement>(null);

  const viewportHeight = useViewportHeight();
  const maxHeight = Math.floor(viewportHeight * maxHeightFraction);
  const maxHeightRef = useRef(maxHeight);
  maxHeightRef.current = maxHeight;

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setIsDragging(true);
    dragStartY.current = e.clientY;
    dragStartHeight.current = cardRef.current?.offsetHeight ?? 200;
  }, []);

  useEffect(() => {
    if (!isDragging) return;

    const handlePointerMove = (e: PointerEvent) => {
      const deltaY = dragStartY.current - e.clientY;
      const newHeight = Math.min(maxHeightRef.current, Math.max(minHeight, dragStartHeight.current + deltaY));
      setManualHeight(newHeight);
    };

    const handlePointerUp = () => setIsDragging(false);

    document.addEventListener("pointermove", handlePointerMove);
    document.addEventListener("pointerup", handlePointerUp);
    document.addEventListener("pointercancel", handlePointerUp);
    return () => {
      document.removeEventListener("pointermove", handlePointerMove);
      document.removeEventListener("pointerup", handlePointerUp);
      document.removeEventListener("pointercancel", handlePointerUp);
    };
  }, [isDragging, minHeight]);

  return (
    <Card
      ref={cardRef}
      variant="surface"
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        // Content-fit by default; manual override when user drags
        ...(manualHeight != null
          ? { height: manualHeight, minHeight }
          : { maxHeight }),
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      {/* Drag handle at top edge */}
      <Box
        onPointerDown={handlePointerDown}
        style={{
          height: 16,
          cursor: "ns-resize",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: isDragging ? "var(--gray-5)" : "var(--gray-4)",
          borderBottom: "1px solid var(--gray-5)",
          flexShrink: 0,
          userSelect: "none",
          touchAction: "none",
        }}
      >
        <DragHandleHorizontalIcon style={{ color: "var(--gray-9)", width: 16, height: 16 }} />
      </Box>

      {/* Header */}
      <Flex
        justify="between"
        align="center"
        px="2"
        py="1"
        flexShrink="0"
        style={{ borderBottom: "1px solid var(--gray-5)" }}
      >
        <Text size="2" weight="bold">{title}</Text>
        <Button variant="ghost" size="1" onClick={onDismiss} style={{ cursor: "pointer" }}>
          <Cross2Icon />
        </Button>
      </Flex>

      {/* Scrollable content — grows to fit, scrolls at max-height */}
      <Box px="3" py="2" flexGrow="1" style={{ minHeight: 0, overflow: "auto" }}>
        <EventErrorBoundary onError={onError}>{children}</EventErrorBoundary>
      </Box>
    </Card>
  );
}
