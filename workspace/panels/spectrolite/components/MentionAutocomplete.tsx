/**
 * Inline @-mention autocomplete adapter for MDXEditor.
 *
 * MDXEditor wraps Lexical, which renders into a contenteditable. Rather
 * than write a custom Lexical plugin (which would require deep MDXEditor
 * realm/gurx integration), we attach a DOM-level keydown listener to the
 * editor's contenteditable root and drive a popover from there.
 *
 * Trigger: typing `@` while the caret is at a word boundary
 * (whitespace/start-of-text/punctuation).
 *
 * Acceptance flow (single-shot, atomic):
 *  - Compute a Range covering the `@<query>` text already in the buffer.
 *  - Set that range as the selection.
 *  - Call `document.execCommand("insertText", false, "@<handle> ")` —
 *    a single operation that *replaces* the selection. Lexical's
 *    contenteditable observer sees one `input` event with inputType
 *    "insertText" and updates its state accordingly.
 *  - If execCommand returns false (browser doesn't support it), fall back
 *    to manual Range.deleteContents + Range.insertNode + a dispatched
 *    `input` event so Lexical still picks up the mutation.
 *
 * Popover follows the caret on scroll/resize via a layout-effect that
 * recomputes the caret rect each frame while the popover is open.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Box, Card, Code, Flex, Text } from "@radix-ui/themes";
import { PersonIcon } from "@radix-ui/react-icons";

export interface MentionCandidate {
  handle: string;
  name?: string;
}

export interface MentionAutocompleteProps {
  container: HTMLElement | null;
  candidates: MentionCandidate[];
  onAccept: (handle: string) => void;
}

interface OpenState {
  /** Characters typed AFTER `@`. */
  query: string;
  /** TextNode that contains the `@` trigger. */
  triggerNode: Node;
  /** Offset of the `@` itself inside `triggerNode`. */
  triggerStart: number;
}

function isTriggerableContext(node: Node, offset: number): boolean {
  if (node.nodeType !== Node.TEXT_NODE) return offset === 0;
  if (offset === 0) return true;
  const prev = node.textContent?.[offset - 1];
  return !prev || /[\s(.,;:!?[{<>]/.test(prev);
}

function tryReplaceSelection(replacement: string): boolean {
  // execCommand returns true on success in browsers that still support it.
  try {
    const ok = document.execCommand("insertText", false, replacement);
    if (ok) return true;
  } catch {
    /* fallthrough */
  }
  // Manual fallback: delete the selection contents and insert a new text
  // node, then dispatch an `input` event so Lexical observes the change.
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return false;
  const range = sel.getRangeAt(0);
  const target = range.startContainer.parentElement ?? range.startContainer;
  range.deleteContents();
  const node = document.createTextNode(replacement);
  range.insertNode(node);
  range.setStartAfter(node);
  range.setEndAfter(node);
  sel.removeAllRanges();
  sel.addRange(range);
  (target as HTMLElement).dispatchEvent?.(new InputEvent("input", { bubbles: true, inputType: "insertText", data: replacement }));
  return true;
}

export function MentionAutocomplete({ container, candidates, onAccept }: MentionAutocompleteProps) {
  const [open, setOpen] = useState<OpenState | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [caretRect, setCaretRect] = useState<DOMRect | null>(null);
  const openRef = useRef(open);
  openRef.current = open;

  const filtered = useMemo(() => {
    if (!open) return [];
    const q = open.query.toLowerCase();
    if (!q) return candidates.slice(0, 8);
    return candidates
      .filter((c) =>
        c.handle.toLowerCase().includes(q) || (c.name?.toLowerCase().includes(q) ?? false),
      )
      .slice(0, 8);
  }, [open, candidates]);

  useEffect(() => {
    if (open && selectedIndex >= filtered.length) setSelectedIndex(0);
  }, [filtered.length, open, selectedIndex]);

  // Reposition the popover to follow the caret. Recompute on every render
  // while open, plus react to scroll/resize events.
  useLayoutEffect(() => {
    if (!open) {
      setCaretRect(null);
      return;
    }
    const recompute = () => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      const r = range.getBoundingClientRect();
      // Some browsers return all-zero rects for collapsed ranges; insert a
      // temp text node and re-measure if so.
      if (r.top === 0 && r.left === 0 && r.bottom === 0) return;
      setCaretRect(r);
    };
    recompute();
    const onScroll = () => recompute();
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onScroll);
    };
  }, [open]);

  const accept = (handle: string) => {
    const sel = window.getSelection();
    const current = openRef.current;
    if (!sel || !current) {
      onAccept(handle);
      setOpen(null);
      return;
    }
    // Build a range spanning [triggerStart .. current caret].
    const range = document.createRange();
    try {
      range.setStart(current.triggerNode, Math.max(0, current.triggerStart));
      const endNode = sel.focusNode ?? current.triggerNode;
      const endOffset = sel.focusOffset ?? current.triggerStart + 1 + current.query.length;
      range.setEnd(endNode, endOffset);
    } catch {
      // Trigger node may have been split/detached; fall back to inserting
      // at the current caret without deleting prefix.
      setOpen(null);
      onAccept(handle);
      return;
    }
    sel.removeAllRanges();
    sel.addRange(range);
    tryReplaceSelection(`@${handle} `);
    setOpen(null);
    onAccept(handle);
  };

  useEffect(() => {
    if (!container) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0) return;
      const range = sel.getRangeAt(0);
      if (!range.collapsed) return;

      const current = openRef.current;

      // Navigation while open
      if (current) {
        if (event.key === "Escape") {
          event.preventDefault();
          setOpen(null);
          return;
        }
        if (event.key === "ArrowDown") {
          event.preventDefault();
          setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          setSelectedIndex((i) => Math.max(0, i - 1));
          return;
        }
        if ((event.key === "Enter" || event.key === "Tab") && filtered.length > 0) {
          event.preventDefault();
          const chosen = filtered[selectedIndex] ?? filtered[0]!;
          accept(chosen.handle);
          return;
        }
      }

      // Open on `@` keypress at a word boundary
      if (event.key === "@") {
        const node = range.startContainer;
        const offset = range.startOffset;
        if (!isTriggerableContext(node, offset)) return;
        // Don't preventDefault — let the browser insert `@` so the
        // contenteditable text and Lexical stay in sync. We track the
        // position so we can later select [trigger..caret] for replacement.
        setOpen({
          query: "",
          triggerStart: offset,
          triggerNode: node,
        });
        setSelectedIndex(0);
        return;
      }

      // Update query as the user types more characters
      if (current && event.key.length === 1 && /[A-Za-z0-9_.-]/.test(event.key)) {
        setOpen((prev) => prev ? { ...prev, query: prev.query + event.key } : prev);
        return;
      }
      if (current && event.key === "Backspace") {
        setOpen((prev) => {
          if (!prev) return prev;
          if (prev.query.length === 0) return null;
          return { ...prev, query: prev.query.slice(0, -1) };
        });
        return;
      }
      // Whitespace or other punctuation closes the popover without action
      if (current && event.key !== "Shift" && event.key !== "Meta" && event.key !== "Control" && event.key !== "Alt") {
        setOpen(null);
      }
    };
    container.addEventListener("keydown", onKeyDown, true);
    return () => container.removeEventListener("keydown", onKeyDown, true);
  }, [container, filtered, selectedIndex, onAccept]);

  if (!open || filtered.length === 0 || !caretRect) return null;

  // Position below the caret by default; flip above if there isn't room
  // (mobile virtual keyboard takes the bottom half of the viewport). Clamp
  // horizontally so the popover never crosses the viewport edge.
  const popoverWidth = 280;
  const popoverHeight = Math.min(filtered.length * 36 + 16, 280);
  const visualVh = (typeof window !== "undefined" ? window.visualViewport?.height : null) ?? window.innerHeight;
  const flipAbove = caretRect.bottom + popoverHeight + 12 > visualVh;
  const top = flipAbove
    ? Math.max(8, caretRect.top - popoverHeight - 4)
    : caretRect.bottom + 4;
  const rawLeft = caretRect.left;
  const left = Math.max(8, Math.min(rawLeft, window.innerWidth - popoverWidth - 8));
  return (
    <Box
      style={{
        position: "fixed",
        top,
        left,
        zIndex: 9999,
        minWidth: 220,
        maxWidth: 320,
        width: popoverWidth,
        pointerEvents: "auto",
      }}
    >
      <Card>
        <Flex direction="column" gap="0">
          {filtered.map((c, idx) => {
            const active = idx === selectedIndex;
            return (
              <Flex
                key={c.handle}
                align="center"
                gap="2"
                px="2"
                py="1"
                style={{
                  background: active ? "var(--accent-3)" : "transparent",
                  cursor: "pointer",
                  borderRadius: "var(--radius-2)",
                }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  accept(c.handle);
                }}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <PersonIcon />
                <Code variant="ghost" size="1">@{c.handle}</Code>
                {c.name ? <Text size="1" color="gray">{c.name}</Text> : null}
              </Flex>
            );
          })}
        </Flex>
      </Card>
    </Box>
  );
}
