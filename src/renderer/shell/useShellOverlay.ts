import { useEffect } from "react";
import { useSetAtom } from "jotai";
import { shellOverlayCountAtom } from "../state/appModeAtoms";

/**
 * Register a shell overlay. When `isOpen` is true, panel WebContentsViews
 * are hidden so the shell dialog/overlay isn't obscured by Electron's
 * native-layer compositing.
 *
 * Usage: call in any component that renders a Radix Dialog, AlertDialog,
 * or other overlay that appears in the panel content area.
 *
 *   useShellOverlay(dialogIsOpen);
 */
export function useShellOverlay(isOpen: boolean): void {
  const setCount = useSetAtom(shellOverlayCountAtom);

  useEffect(() => {
    if (!isOpen) return;
    setCount((c) => c + 1);
    return () => {
      setCount((c) => c - 1);
    };
  }, [isOpen, setCount]);
}
