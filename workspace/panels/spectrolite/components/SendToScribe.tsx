/**
 * SendToScribe — the explicit "ask the scribe" affordance.
 *
 * Invoking the scribe is a deliberate user action, decoupled from autosave: a
 * half-typed `@scribe` line never dispatches. The button opens a small composer
 * (pre-filled with any current editor selection as quoted context). On send we
 * {@link sendToScribe}, which **commits pending dirty blocks first** and then
 * dispatches referencing the committed `stateHash` so the scribe reads exactly
 * what the user saw.
 */

import { useState } from "react";
import { Box, Button, Flex, Popover, Text, TextArea } from "@radix-ui/themes";
import { ChatBubbleIcon, PaperPlaneIcon } from "@radix-ui/react-icons";
import { sendToScribe } from "../app/scribeDispatch";
import { useApp, useAppState } from "../app/context";

/** Read the current text selection if it falls inside the editor surface. */
function currentSelection(): string | undefined {
  const sel = typeof window !== "undefined" ? window.getSelection() : null;
  if (!sel || sel.isCollapsed) return undefined;
  const text = sel.toString().trim();
  if (!text) return undefined;
  const node = sel.anchorNode;
  const host = node instanceof Element ? node : node?.parentElement;
  if (host && host.closest('[data-testid="spectrolite-editor"]')) return text;
  return undefined;
}

export function SendToScribe({
  size = "1",
  compact = false,
}: {
  size?: "1" | "2";
  /** Icon-only trigger (for the dense mobile action bar). */
  compact?: boolean;
}) {
  const app = useApp();
  const activePath = useAppState((s) => s.activePath);
  const scribeHandle = useAppState(
    (s) => s.roster.find((a) => a.handle.startsWith("scribe"))?.handle ?? "scribe",
  );
  const clientReady = useAppState((s) => s.client !== null);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [selection, setSelection] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const beginCompose = () => {
    setSelection(currentSelection());
    setMessage("");
    setOpen(true);
  };

  const submit = async () => {
    const text = message.trim();
    if (!text || !activePath) return;
    setBusy(true);
    try {
      const vcsPath = app.vault.mapping().toVcsPath(activePath);
      await sendToScribe(
        {
          // The deliberate commit that grounds the scribe in what the user saw.
          commitPending: () => app.commitActiveDoc("Snapshot for @scribe"),
          send: (content, opts) => app.session.send(content, opts),
        },
        {
          message: text,
          handle: scribeHandle,
          context: { path: vcsPath, selection },
        },
      );
      setOpen(false);
      setMessage("");
      app.session.openDock();
    } catch (err) {
      console.warn("[Spectrolite] send to scribe failed:", err);
    } finally {
      setBusy(false);
    }
  };

  if (!activePath) return null;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger>
        <Button
          size={size}
          variant="soft"
          color="iris"
          onClick={beginCompose}
          disabled={!clientReady}
          data-testid="spectrolite-send-to-scribe"
          aria-label={`Ask @${scribeHandle}`}
          title={`Ask @${scribeHandle}`}
          style={compact ? { minHeight: 40 } : undefined}
        >
          <ChatBubbleIcon /> {compact ? null : `Ask @${scribeHandle}`}
        </Button>
      </Popover.Trigger>
      <Popover.Content width="340px" data-testid="spectrolite-send-to-scribe-popover">
        <Flex direction="column" gap="2">
          {selection ? (
            <Box
              style={{
                fontFamily: "var(--font-mono)",
                fontSize: "var(--font-size-1)",
                color: "var(--gray-11)",
                background: "var(--gray-2)",
                borderRadius: "var(--radius-2)",
                padding: "var(--space-2)",
                maxHeight: 100,
                overflow: "auto",
                whiteSpace: "pre-wrap",
              }}
            >
              {selection.length > 280 ? `${selection.slice(0, 280)}…` : selection}
            </Box>
          ) : (
            <Text size="1" color="gray">
              Ask @{scribeHandle} to edit this note. Your pending edits are saved first.
            </Text>
          )}
          <TextArea
            autoFocus
            placeholder={selection ? "What should the scribe do with this?" : "What should the scribe do?"}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={3}
            data-testid="spectrolite-send-to-scribe-input"
          />
          <Flex justify="end">
            <Button
              size="1"
              variant="solid"
              color="iris"
              disabled={!message.trim() || busy}
              onClick={() => void submit()}
              data-testid="spectrolite-send-to-scribe-submit"
            >
              <PaperPlaneIcon /> Send
            </Button>
          </Flex>
        </Flex>
      </Popover.Content>
    </Popover.Root>
  );
}
