import { useCallback, useEffect, useRef, useState } from "react";

interface ScrollToBottomOptions {
  animation?: ScrollBehavior;
}

interface StickToBottomOptions {
  initial?: ScrollBehavior;
  resize?: ScrollBehavior;
  threshold?: number;
}

type CallbackRef<T> = ((node: T | null) => void) & { current: T | null };

function createCallbackRef<T>(): CallbackRef<T> {
  const ref = ((node: T | null) => {
    ref.current = node;
  }) as CallbackRef<T>;
  ref.current = null;
  return ref;
}

function atBottom(element: HTMLElement, threshold: number): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= threshold;
}

export function useStickToBottom(options: StickToBottomOptions = {}) {
  const threshold = options.threshold ?? 32;
  const scrollRef = useRef<CallbackRef<HTMLElement>>(createCallbackRef<HTMLElement>()).current;
  const contentRef = useRef<CallbackRef<HTMLElement>>(createCallbackRef<HTMLElement>()).current;
  const [isAtBottom, setIsAtBottom] = useState(true);
  const pinnedRef = useRef(true);

  const scrollToBottom = useCallback((scrollOptions: ScrollToBottomOptions = {}) => {
    const viewport = scrollRef.current;
    if (!viewport) return false;
    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: scrollOptions.animation ?? "instant",
    });
    pinnedRef.current = true;
    setIsAtBottom(true);
    return true;
  }, [scrollRef]);

  useEffect(() => {
    const viewport = scrollRef.current;
    if (!viewport) return;
    const updatePinned = () => {
      const next = atBottom(viewport, threshold);
      pinnedRef.current = next;
      setIsAtBottom(next);
    };
    viewport.addEventListener("scroll", updatePinned, { passive: true });
    if (options.initial) {
      scrollToBottom({ animation: options.initial });
    } else {
      updatePinned();
    }
    return () => viewport.removeEventListener("scroll", updatePinned);
  }, [options.initial, scrollRef, scrollToBottom, threshold]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (pinnedRef.current) {
        scrollToBottom({ animation: options.resize ?? "instant" });
      }
    });
    observer.observe(content);
    return () => observer.disconnect();
  }, [contentRef, options.resize, scrollToBottom]);

  return {
    scrollRef,
    contentRef,
    scrollToBottom,
    isAtBottom,
  };
}
