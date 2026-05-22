/**
 * Mobile slide-in sidebar — wraps the file tree + backlinks panel and
 * makes them tap-to-open at narrow viewport widths.
 *
 * Slides in from the left over the editor; a translucent backdrop
 * dismisses on tap. Uses pointer-events + transform so the animation is
 * cheap and the editor stays interactive when the sidebar is closed.
 */

import type { ReactNode } from "react";
import { Box, Flex } from "@radix-ui/themes";

export interface MobileSidebarProps {
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  /** Width of the slide-in panel. Defaults to min(85vw, 320px). */
  width?: string;
}

export function MobileSidebar({ open, onClose, children, width = "min(85vw, 320px)" }: MobileSidebarProps) {
  return (
    <>
      {/* Backdrop — only intercepts taps when the sidebar is open. */}
      <Box
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.4)",
          opacity: open ? 1 : 0,
          pointerEvents: open ? "auto" : "none",
          transition: "opacity 180ms ease",
          zIndex: 50,
        }}
        aria-hidden={!open}
      />
      <Flex
        direction="column"
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          bottom: 0,
          width,
          maxWidth: "100vw",
          background: "var(--color-panel-solid)",
          borderRight: "1px solid var(--gray-5)",
          transform: open ? "translateX(0)" : "translateX(-100%)",
          transition: "transform 200ms ease",
          zIndex: 51,
          overflow: "hidden",
        }}
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
      >
        {children}
      </Flex>
    </>
  );
}
