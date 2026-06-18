import { useEffect, useRef } from "react";
import {
  nativeShellOverlay,
  view,
  type NativeShellOverlayEvent,
  type NativeShellOverlayOptions,
} from "./client";

export function useNativeShellOverlay(
  options: (NativeShellOverlayOptions & { open: boolean }) | null,
  onOverlayEvent?: (event: NativeShellOverlayEvent) => void
): void {
  const visibleIdRef = useRef<string | null>(null);
  const lastOptionsKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!options?.open) return;
    visibleIdRef.current = options.id;
    lastOptionsKeyRef.current = getOverlayOptionsKey(options);
    void view.showNativeShellOverlay(options);
    return () => {
      if (visibleIdRef.current === options.id) visibleIdRef.current = null;
      if (lastOptionsKeyRef.current) lastOptionsKeyRef.current = null;
      void view.hideNativeShellOverlay(options.id);
    };
  }, [options?.id, options?.open]);

  useEffect(() => {
    if (!options?.open || visibleIdRef.current !== options.id) return;
    const key = getOverlayOptionsKey(options);
    if (lastOptionsKeyRef.current === key) return;
    lastOptionsKeyRef.current = key;
    void view.updateNativeShellOverlay({
      id: options.id,
      rows: options.rows,
      empty: options.empty,
      bounds: options.bounds,
      focus: options.focus,
    });
  }, [
    options?.bounds.height,
    options?.bounds.width,
    options?.bounds.x,
    options?.bounds.y,
    options?.focus,
    options?.empty,
    options?.rows,
    options?.id,
    options?.open,
  ]);

  useEffect(() => {
    if (!onOverlayEvent) return;
    return nativeShellOverlay.on((event) => {
      if (!options?.id || event.overlayId === options.id) {
        onOverlayEvent(event);
      }
    });
  }, [onOverlayEvent, options?.id]);
}

function getOverlayOptionsKey(options: NativeShellOverlayOptions): string {
  const { bounds } = options;
  return `${options.id}:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${options.focus ? "1" : "0"}:${options.empty}:${JSON.stringify(options.rows)}`;
}
