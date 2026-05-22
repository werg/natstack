/**
 * Mobile slide-in sidebar — wraps the file tree + backlinks panel and
 * makes them tap-to-open at narrow viewport widths.
 *
 * Implemented as a Radix `Dialog` so the platform gives us focus
 * trapping, Escape-to-close, focus restoration on close, and ARIA
 * dialog semantics for free. Unmounting on close keeps tabbable
 * controls out of the keyboard tab order when the panel isn't visible.
 */

import type { ReactNode } from "react";
import { Box, Dialog, Flex } from "@radix-ui/themes";

export interface MobileSidebarProps {
  open: boolean;
  onClose: () => void;
  /** Accessible dialog name. Rendered visually-hidden — the file tree
   *  has its own visual header. */
  title?: string;
  children: ReactNode;
  /** Width of the slide-in panel. Defaults to min(85vw, 320px). */
  width?: string;
}

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

export function MobileSidebar({
  open,
  onClose,
  title = "Files",
  children,
  width = "min(85vw, 320px)",
}: MobileSidebarProps) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Content
        // Override Radix Themes' centred-card styling — we want a
        // full-height left-anchored panel.
        maxWidth="100vw"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          right: "auto",
          width,
          maxWidth: "100vw",
          margin: 0,
          padding: 0,
          borderRadius: 0,
          borderRight: "1px solid var(--gray-5)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <VisuallyHidden>
          <Dialog.Title>{title}</Dialog.Title>
        </VisuallyHidden>
        <Flex direction="column" style={{ height: "100%", minHeight: 0 }}>
          <Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            {children}
          </Box>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
