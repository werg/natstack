/**
 * Bottom sheet — a modal that slides up from the bottom of the viewport.
 *
 * Used for the mobile commit flow and the overflow menu, where the
 * full desktop strip/panel doesn't fit. Uses Radix Themes' Dialog for
 * focus trapping + Escape-to-dismiss + scroll lock, and overrides the
 * positioning via inline styles to anchor at the bottom.
 *
 * Resizes against `useViewportHeight()` so the sheet stays out from
 * under the virtual keyboard.
 */

import type { ReactNode } from "react";
import { Box, Dialog, Flex, IconButton, Text } from "@radix-ui/themes";
import { Cross2Icon } from "@radix-ui/react-icons";
import { useViewportHeight } from "@workspace/react";

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: string;
  children: ReactNode;
}

export function BottomSheet({ open, onOpenChange, title, children }: BottomSheetProps) {
  const vh = useViewportHeight();
  const maxHeight = Math.min(vh * 0.9, 720);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content
        style={{
          // Anchor at the bottom; full viewport width on mobile.
          position: "fixed",
          left: "50%",
          bottom: 0,
          top: "auto",
          transform: "translateX(-50%)",
          width: "100vw",
          maxWidth: "640px",
          maxHeight,
          margin: 0,
          padding: 0,
          borderTopLeftRadius: "var(--radius-4)",
          borderTopRightRadius: "var(--radius-4)",
          borderBottomLeftRadius: 0,
          borderBottomRightRadius: 0,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        {title ? (
          <Flex align="center" justify="between" px="4" py="3" style={{ borderBottom: "1px solid var(--gray-5)" }}>
            <Text size="3" weight="medium">{title}</Text>
            <Dialog.Close>
              <IconButton variant="ghost" color="gray" aria-label="Close">
                <Cross2Icon />
              </IconButton>
            </Dialog.Close>
          </Flex>
        ) : null}
        <Box style={{ flex: 1, minHeight: 0, overflowY: "auto" }} p="4">
          {children}
        </Box>
      </Dialog.Content>
    </Dialog.Root>
  );
}
