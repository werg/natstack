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
import { Box, Dialog, Flex, IconButton } from "@radix-ui/themes";
import { Cross2Icon } from "@radix-ui/react-icons";
import { useViewportHeight } from "@workspace/react";

export interface BottomSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Visible heading rendered at the top of the sheet. Omit for a
   *  no-chrome sheet; you MUST still pass `accessibleTitle` so screen
   *  readers have a name for the dialog. */
  title?: string;
  /** Screen-reader-only fallback title. Defaults to `title` when set;
   *  required otherwise. */
  accessibleTitle?: string;
  children: ReactNode;
}

/** Render-only-for-screen-readers wrapper. Radix Themes doesn't expose
 *  a `VisuallyHidden` primitive, so we inline the CSS that the @radix-ui
 *  visually-hidden package uses (clip-path + 1px). */
function VisuallyHidden({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        position: "absolute",
        border: 0,
        width: 1,
        height: 1,
        padding: 0,
        margin: -1,
        overflow: "hidden",
        clip: "rect(0, 0, 0, 0)",
        whiteSpace: "nowrap",
        wordWrap: "normal",
      }}
    >
      {children}
    </span>
  );
}

export function BottomSheet({ open, onOpenChange, title, accessibleTitle, children }: BottomSheetProps) {
  const vh = useViewportHeight();
  const maxHeight = Math.min(vh * 0.9, 720);
  const a11yLabel = title ?? accessibleTitle ?? "Sheet";
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
            <Dialog.Title size="3" weight="medium" mb="0">{title}</Dialog.Title>
            <Dialog.Close>
              <IconButton variant="ghost" color="gray" aria-label="Close">
                <Cross2Icon />
              </IconButton>
            </Dialog.Close>
          </Flex>
        ) : (
          // Radix Dialog requires a Title for screen readers. Hide it
          // visually when the sheet doesn't render a visible header.
          <VisuallyHidden>
            <Dialog.Title>{a11yLabel}</Dialog.Title>
          </VisuallyHidden>
        )}
        <Box style={{ flex: 1, minHeight: 0, overflowY: "auto" }} p="4">
          {children}
        </Box>
      </Dialog.Content>
    </Dialog.Root>
  );
}
