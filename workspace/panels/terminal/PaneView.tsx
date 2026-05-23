import { Box, Button, ContextMenu, Flex, IconButton, Text } from "@radix-ui/themes";
import { ArrowDownIcon } from "@radix-ui/react-icons";
import { focusPanel, notifications, openExternal, slotId as runtimeSlotId } from "@workspace/runtime";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { DropOverlay } from "./DropOverlay.js";
import { FindBar } from "./FindBar.js";
import { findStatus } from "./findModel.js";
import {
  extensionFromMime,
  fetchUrlForPaste,
  fileToBytes,
  stashPasteBatch,
  type StashedPaste,
} from "./imagePaste.js";
import type { ParsedNotification } from "./notificationParser.js";
import { resolveTerminalTheme, type TerminalAppearance } from "./paneTheme.js";
import { paneAttentionShadow, paneBorderColor } from "./paneChrome.js";
import { PaneHeader, previewTarget } from "./PaneHeader.js";
import { sessionFooterText } from "./sessionStatus.js";
import type { TerminalSearchOptions } from "./terminalFrontend.js";
import type { NotificationSeverity, SessionInfo, ShellApi } from "./types.js";
import { createVscodeTerminalFrontend } from "./vscodeTerminalFrontend.js";
import { VscodeTerminalInstance } from "./vscodeTerminalInstance.js";
import {
  isVscodeShellIntegrationMeta,
  liveSessionCwd,
  reduceVscodeShellIntegrationMeta,
  VSCODE_SHELL_INTEGRATION_META_KEY,
  type VscodeShellIntegrationMeta,
} from "./vscodeShellIntegrationMeta.js";
import type { VscodeShellIntegrationEvent } from "./vscodeShellIntegration.js";
import "@xterm/xterm/css/xterm.css";

const IMAGE_PASTE_HINT_KEY = "terminal.imagePasteScratchHintShown";

declare global {
  interface Window {
    __natstackTerminalPaneTestRegistry?: Record<string, { serialize(): string }>;
  }
}

export function PaneView(props: {
  shell: ShellApi;
  session: SessionInfo;
  fontSize: number;
  fontFamily: string;
  appearance: TerminalAppearance;
  pasteMode: "path" | "dataUri" | "both";
  imagePasteRelative: boolean;
  resizeKey?: number;
  focused: boolean;
  severity: NotificationSeverity;
  settingsControl?: ReactNode;
  onFocus(): void;
  onClose(): void;
  onSplitRight(): void;
  onSplitDown(): void;
  onOpenPort(port: number): void;
  onOpenUrl(url: string): void;
  onClear(): void;
  onDuplicate(): void;
  onRestart(): void;
  onRestartCommand(): void;
  onFind(): void;
  onZoom(): void;
  onOpenScratch(): void;
  onNotification(notification: ParsedNotification): void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const terminalRef = useRef<VscodeTerminalInstance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retryKey, setRetryKey] = useState(0);
  const [dragDepth, setDragDepth] = useState(0);
  const sessionShellRef = useRef(props.shell);
  const notificationRef = useRef(props.onNotification);
  const labelRef = useRef(props.session.label);
  const shellIntegrationMetaRef = useRef<VscodeShellIntegrationMeta | undefined>(
    readShellIntegrationMeta(props.session)
  );
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [findMatched, setFindMatched] = useState<boolean | undefined>(undefined);
  const [findResult, setFindResult] = useState<{ index: number; count: number }>({
    index: -1,
    count: 0,
  });
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const autoScrollRef = useRef(true);
  const liveCwd = liveSessionCwd(props.session) ?? props.session.command.cwd;

  useEffect(() => {
    notificationRef.current = props.onNotification;
  }, [props.onNotification]);

  useEffect(() => {
    sessionShellRef.current = props.shell;
  }, [props.shell]);

  useEffect(() => {
    shellIntegrationMetaRef.current = readShellIntegrationMeta(props.session);
    labelRef.current = props.session.label;
  }, [props.session]);

  useEffect(() => {
    const host = hostRef.current;
    const sessionId = props.session.sessionId;
    const shell = props.shell;
    sessionShellRef.current = shell;
    if (!host) return;
    setError(null);
    const terminal = new VscodeTerminalInstance({
      sessionId,
      shell,
      frontendFactory: createVscodeTerminalFrontend,
      fontFamily: props.fontFamily,
      fontSize: props.fontSize,
      theme: resolveTerminalTheme(props.appearance, host),
      focused: props.focused,
      onError: setError,
      onNotification: (notification) => notificationRef.current(notification),
      onFindResult: (result) => setFindResult(result),
      onScrollStateChange: (scrolledUp) => {
        autoScrollRef.current = !scrolledUp;
        setShowJumpToBottom(scrolledUp);
      },
      onShellIntegrationEvent: (event) => handleShellIntegrationEvent(event, sessionId),
      onTitleChange: (title) => handleTitleChange(title, sessionId),
    });
    terminalRef.current = terminal;
    window.__natstackTerminalPaneTestRegistry ??= {};
    const testEntry = {
      serialize: () => terminal.serialize(),
    };
    window.__natstackTerminalPaneTestRegistry[sessionId] = testEntry;
    void terminal.attach(host);
    return () => {
      if (window.__natstackTerminalPaneTestRegistry?.[sessionId] === testEntry) {
        delete window.__natstackTerminalPaneTestRegistry[sessionId];
      }
      terminal.dispose();
      if (terminalRef.current === terminal) terminalRef.current = null;
    };
  }, [props.session.sessionId, props.fontSize, props.fontFamily, retryKey]);

  useEffect(() => {
    if (props.resizeKey === undefined) return;
    const frame = requestAnimationFrame(() => terminalRef.current?.fit());
    return () => cancelAnimationFrame(frame);
  }, [props.resizeKey]);

  useEffect(() => {
    terminalRef.current?.setTheme(resolveTerminalTheme(props.appearance, hostRef.current));
  }, [props.appearance]);

  useEffect(() => {
    if (!props.focused) return;
    const frame = requestAnimationFrame(() => terminalRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [props.focused]);

  useEffect(() => {
    const openFind = () => {
      if (props.focused) setFindOpen(true);
    };
    const next = () => {
      if (props.focused && findQuery)
        runFind(
          terminalRef.current,
          "next",
          findQuery,
          caseSensitive,
          regex,
          setFindMatched,
          setFindResult
        );
    };
    const previous = () => {
      if (props.focused && findQuery)
        runFind(
          terminalRef.current,
          "previous",
          findQuery,
          caseSensitive,
          regex,
          setFindMatched,
          setFindResult
        );
    };
    window.addEventListener("terminal:find", openFind);
    window.addEventListener("terminal:find-next", next);
    window.addEventListener("terminal:find-previous", previous);
    return () => {
      window.removeEventListener("terminal:find", openFind);
      window.removeEventListener("terminal:find-next", next);
      window.removeEventListener("terminal:find-previous", previous);
    };
  }, [caseSensitive, findQuery, props.focused, regex]);

  useEffect(() => {
    if (!findOpen || !findQuery) {
      setFindMatched(undefined);
      setFindResult({ index: -1, count: 0 });
      return;
    }
    const matched = terminalRef.current?.findNext(findQuery, searchOptions(caseSensitive, regex)) ?? false;
    setFindMatched(matched);
    if (!matched) setFindResult({ index: -1, count: 0 });
  }, [findOpen, findQuery, caseSensitive, regex]);

  async function copySelection() {
    const selection = terminalRef.current?.getSelection?.() || window.getSelection()?.toString();
    if (selection) await navigator.clipboard.writeText(selection);
  }

  async function pasteClipboard() {
    const files = await readClipboardFiles();
    if (files.length) {
      props.onFocus();
      await handleFiles(files);
      return;
    }
    const text = await navigator.clipboard.readText();
    if (text) await sessionShellRef.current.write(props.session.sessionId, text);
  }

  useEffect(() => {
    const copy = () => {
      if (props.focused) void copySelection();
    };
    const paste = () => {
      if (props.focused) void pasteClipboard();
    };
    const refocus = () => {
      if (props.focused) requestAnimationFrame(() => terminalRef.current?.focus());
    };
    window.addEventListener("terminal:copy", copy);
    window.addEventListener("terminal:paste", paste);
    window.addEventListener("terminal:refocus", refocus);
    return () => {
      window.removeEventListener("terminal:copy", copy);
      window.removeEventListener("terminal:paste", paste);
      window.removeEventListener("terminal:refocus", refocus);
    };
  }, [
    props.focused,
    props.session.sessionId,
    liveCwd,
    props.pasteMode,
    props.imagePasteRelative,
    props.shell,
  ]);

  function selectAll() {
    terminalRef.current?.selectAll?.();
  }

  function focusPane() {
    props.onFocus();
    void focusPanel(runtimeSlotId).catch(() => {});
    window.focus();
    requestAnimationFrame(() => terminalRef.current?.focus?.());
  }

  function handleShellIntegrationEvent(
    event: VscodeShellIntegrationEvent,
    sessionId: string
  ): void {
    const next = reduceVscodeShellIntegrationMeta(
      shellIntegrationMetaRef.current,
      event,
      Date.now()
    );
    if (shellIntegrationMetaEqual(shellIntegrationMetaRef.current, next)) return;
    shellIntegrationMetaRef.current = next;
    void sessionShellRef.current
      .setMeta?.(sessionId, VSCODE_SHELL_INTEGRATION_META_KEY, next)
      .catch((err) => console.warn("Failed to update terminal shell integration metadata", err));
  }

  function handleTitleChange(title: string, sessionId: string): void {
    const next = title.trim();
    if (!next || next === labelRef.current) return;
    labelRef.current = next;
    void sessionShellRef.current
      .setLabel?.(sessionId, next)
      .catch((err) => console.warn("Failed to update terminal title", err));
  }

  async function copyAll() {
    const scrollback = await sessionShellRef.current.getScrollback(
      props.session.sessionId,
      8 * 1024 * 1024
    );
    await navigator.clipboard.writeText(scrollback.text);
    void notifications.show({ type: "success", title: "Terminal copied", ttl: 1000 });
  }

  async function renameSession() {
    const label = window.prompt("Session name", props.session.label);
    if (!label?.trim()) return;
    await sessionShellRef.current.setLabel?.(props.session.sessionId, label.trim());
  }

  async function handleFiles(files: File[]): Promise<boolean> {
    if (!files.length) return false;
    const items = await Promise.all(
      files.map(async (file) => ({
        bytes: await fileToBytes(file),
        mime: file.type || "application/octet-stream",
      }))
    );
    const batch = await stashPasteBatch({
      shell: sessionShellRef.current,
      items,
      cwd: liveCwd,
      pasteMode: props.pasteMode,
      imagePasteRelative: props.imagePasteRelative,
    });
    for (const error of batch.errors) {
      void notifications.show({
        type: "error",
        title: "Couldn't save file",
        message: error.message,
        ttl: 3000,
      });
    }
    for (const { index, paste } of batch.stashed) {
      const file = files[index];
      if (file)
        showStashToast(paste, file.type.startsWith("image/") ? "Image pasted" : "File pasted");
    }
    if (!batch.pasteText) return false;
    await sessionShellRef.current.write(props.session.sessionId, batch.pasteText);
    return batch.errors.length === 0;
  }

  async function handlePasteEvent(event: React.ClipboardEvent<HTMLDivElement>) {
    const files = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => !!file);
    if (files.length) {
      event.preventDefault();
      props.onFocus();
      await handleFiles(files).catch((err) => {
        void notifications.show({
          type: "error",
          title: "Couldn't save file",
          message: err instanceof Error ? err.message : String(err),
          ttl: 3000,
        });
      });
      return;
    }

    if (clipboardHasText(event.clipboardData)) return;

    event.preventDefault();
    props.onFocus();
    const fallbackFiles = await readClipboardFiles();
    if (!fallbackFiles.length) return;
    await handleFiles(fallbackFiles).catch((err) => {
      void notifications.show({
        type: "error",
        title: "Couldn't save file",
        message: err instanceof Error ? err.message : String(err),
        ttl: 3000,
      });
    });
  }

  async function handleDrop(event: React.DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragDepth(0);
    props.onFocus();
    const files = Array.from(event.dataTransfer.files);
    if (files.length) {
      await handleFiles(files).catch((err) => {
        void notifications.show({
          type: "error",
          title: "Couldn't save file",
          message: err instanceof Error ? err.message : String(err),
          ttl: 3000,
        });
      });
      return;
    }
    const uri =
      event.dataTransfer.getData("text/uri-list") || event.dataTransfer.getData("text/plain");
    if (uri) {
      const firstUri = uri.split(/\r?\n/).find((line) => line && !line.startsWith("#")) ?? uri;
      try {
        const stashed = await fetchUrlForPaste({
          shell: sessionShellRef.current,
          url: firstUri,
          cwd: liveCwd,
          pasteMode: props.pasteMode,
          imagePasteRelative: props.imagePasteRelative,
        });
        if (stashed) {
          await sessionShellRef.current.write(props.session.sessionId, stashed.pasteText);
          showStashToast(stashed, "URL content pasted");
          return;
        }
      } catch (err) {
        void notifications.show({
          type: "warning",
          title: "URL pasted without stashing",
          message: err instanceof Error ? err.message : String(err),
          ttl: 2500,
        });
      }
      await sessionShellRef.current.write(props.session.sessionId, firstUri);
    }
  }

  async function handlePickedFiles(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    event.currentTarget.value = "";
    if (!files.length) return;
    props.onFocus();
    await handleFiles(files).catch((err) => {
      void notifications.show({
        type: "error",
        title: "Couldn't save file",
        message: err instanceof Error ? err.message : String(err),
        ttl: 3000,
      });
    });
  }

  function showStashToast(stashed: StashedPaste, title: string) {
    if (!stashed.absolutePath) return;
    const hint = consumeImagePasteHint();
    const absolutePath = stashed.absolutePath;
    void notifications.show({
      type: "success",
      title,
      message: hint
        ? `${absolutePath}\nImages and files are saved to .snug/scratch/ and cleaned after 24h.`
        : absolutePath,
      ttl: hint ? 3500 : 1500,
      actions: [
        {
          id: "reveal",
          label: "Reveal",
          variant: "soft",
          onClick: () => revealStashedPath(absolutePath),
        },
      ],
    });
  }

  const pane = (
    <Flex
      direction="column"
      style={{
        flex: 1,
        height: "100%",
        minHeight: 0,
        minWidth: 0,
        border: `1px solid ${paneBorderColor(props.severity, props.focused)}`,
        borderRadius: 6,
        overflow: "hidden",
        background: "var(--gray-1)",
        boxShadow: paneAttentionShadow(props.severity),
      }}
      onPointerDownCapture={focusPane}
      onMouseDown={focusPane}
      onPaste={(event) => void handlePasteEvent(event)}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragDepth((depth) => depth + 1);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={() => setDragDepth((depth) => Math.max(0, depth - 1))}
      onDrop={(event) => void handleDrop(event)}
      onKeyDown={(event) => {
        const isMac = /mac/i.test(navigator.platform);
        const copyChord = isMac
          ? event.metaKey && event.key.toLowerCase() === "c"
          : event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "c";
        const pasteChord = isMac
          ? event.metaKey && event.key.toLowerCase() === "v"
          : event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "v";
        if (copyChord) {
          event.preventDefault();
          void copySelection();
        } else if (pasteChord) {
          event.preventDefault();
          void pasteClipboard();
        }
      }}
    >
      <PaneHeader
        session={props.session}
        focused={props.focused}
        severity={props.severity}
        settingsControl={props.settingsControl}
        onSplitRight={props.onSplitRight}
        onSplitDown={props.onSplitDown}
        onOpenPort={props.onOpenPort}
        onClose={props.onClose}
        onClear={props.onClear}
        onCopyAll={() => void copyAll()}
        onDuplicate={props.onDuplicate}
        onOpenPreview={() => {
          const target = previewTarget(props.session);
          if (target?.kind === "url") props.onOpenUrl(target.url);
          else if (target?.kind === "port") props.onOpenPort(target.port);
        }}
        onRename={() => void renameSession()}
        onRestart={props.onRestart}
        onRestartCommand={props.onRestartCommand}
        onFind={() => setFindOpen(true)}
        onZoom={props.onZoom}
        onOpenScratch={props.onOpenScratch}
      />
      <div
        ref={hostRef}
        style={{ flex: 1, minHeight: 0, minWidth: 0, overflow: "hidden", background: "var(--gray-1)", position: "relative" }}
      >
        <DropOverlay visible={dragDepth > 0} target=".snug/scratch/..." />
        {showJumpToBottom ? (
          <IconButton
            size="2"
            variant="solid"
            aria-label="Jump to bottom"
            onClick={() => {
              terminalRef.current?.scrollToBottom();
              autoScrollRef.current = true;
              setShowJumpToBottom(false);
            }}
            style={{
              position: "absolute",
              right: "0.75rem",
              bottom: "0.75rem",
              zIndex: 3,
              boxShadow: "var(--shadow-3)",
            }}
          >
            <ArrowDownIcon />
          </IconButton>
        ) : null}
        {error ? (
          <Flex height="100%" align="center" justify="center" direction="column" gap="2">
            <Text size="2" color="red">
              {error}
            </Text>
            <Button size="1" variant="soft" onClick={() => setRetryKey((value) => value + 1)}>
              Retry
            </Button>
          </Flex>
        ) : null}
      </div>
      <Box px="2" py="1">
        <Text size="1" color={props.session.alive ? "gray" : "red"}>
          {sessionFooterText(props.session)}
        </Text>
      </Box>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden="true"
        onChange={(event) => void handlePickedFiles(event)}
        style={{ display: "none" }}
      />
      {findOpen ? (
        <FindBar
          value={findQuery}
          caseSensitive={caseSensitive}
          regex={regex}
          status={findStatus(findQuery, findMatched, findResult)}
          onChange={setFindQuery}
          onCaseSensitiveChange={setCaseSensitive}
          onRegexChange={setRegex}
          onNext={() =>
            findQuery &&
            runFind(
              terminalRef.current,
              "next",
              findQuery,
              caseSensitive,
              regex,
              setFindMatched,
              setFindResult
            )
          }
          onPrevious={() =>
            findQuery &&
            runFind(
              terminalRef.current,
              "previous",
              findQuery,
              caseSensitive,
              regex,
              setFindMatched,
              setFindResult
            )
          }
          onUseSelection={() => {
            const selection = terminalRef.current?.getSelection?.();
            if (selection) setFindQuery(selection);
          }}
          onClose={() => {
            setFindOpen(false);
            setFindQuery("");
            setFindMatched(undefined);
            setFindResult({ index: -1, count: 0 });
            terminalRef.current?.clearSearch();
          }}
        />
      ) : null}
    </Flex>
  );

  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{pane}</ContextMenu.Trigger>
      <ContextMenu.Content>
        <ContextMenu.Item onSelect={() => void copySelection()}>Copy</ContextMenu.Item>
        <ContextMenu.Item onSelect={() => void pasteClipboard()}>Paste</ContextMenu.Item>
        <ContextMenu.Item onSelect={() => fileInputRef.current?.click()}>
          Paste image...
        </ContextMenu.Item>
        <ContextMenu.Item onSelect={selectAll}>Select all</ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item onSelect={() => setFindOpen(true)}>Find</ContextMenu.Item>
        <ContextMenu.Item onSelect={props.onClear}>Clear scrollback</ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item onSelect={props.onSplitRight}>Split right</ContextMenu.Item>
        <ContextMenu.Item onSelect={props.onSplitDown}>Split down</ContextMenu.Item>
        <ContextMenu.Item onSelect={props.onDuplicate}>Duplicate</ContextMenu.Item>
        <ContextMenu.Separator />
        <ContextMenu.Item onSelect={props.onRestart}>Restart session</ContextMenu.Item>
        <ContextMenu.Item onSelect={props.onRestartCommand}>Restart command</ContextMenu.Item>
        <ContextMenu.Item color="red" onSelect={props.onClose}>
          Close
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}

async function readClipboardFiles(): Promise<File[]> {
  const clipboard = navigator.clipboard as Clipboard & { read?: () => Promise<ClipboardItem[]> };
  if (!clipboard?.read) return [];
  let items: ClipboardItem[];
  try {
    items = await clipboard.read();
  } catch (err) {
    const name = err instanceof DOMException ? err.name : "";
    if (name === "NotAllowedError" || name === "DataError") return [];
    console.warn("Could not read image clipboard", err);
    return [];
  }
  const files: File[] = [];
  for (const item of items) {
    const type = item.types.find((candidate) => candidate.startsWith("image/"));
    if (!type) continue;
    const blob = await item.getType(type);
    files.push(new File([blob], `clipboard.${extensionFromMime(type)}`, { type }));
  }
  return files;
}

function clipboardHasText(data: DataTransfer): boolean {
  return Array.from(data.types).some(
    (type) => type === "text/plain" || type === "text/html" || type === "text/uri-list"
  );
}

function consumeImagePasteHint(): boolean {
  try {
    if (window.localStorage.getItem(IMAGE_PASTE_HINT_KEY)) return false;
    window.localStorage.setItem(IMAGE_PASTE_HINT_KEY, "1");
    return true;
  } catch {
    return false;
  }
}

async function revealStashedPath(absolutePath: string): Promise<void> {
  try {
    await openExternal(absolutePath);
  } catch {
    await navigator.clipboard?.writeText(absolutePath).catch(() => {});
  }
}

function searchOptions(caseSensitive: boolean, regex: boolean): TerminalSearchOptions {
  return {
    caseSensitive,
    regex,
    decorations: {
      activeMatchBackground: "#253974",
      activeMatchBorder: "#6e80ff",
      activeMatchColorOverviewRuler: "#6e80ff",
      matchBackground: "#1f2c55",
      matchBorder: "#5064d8",
      matchOverviewRuler: "#5064d8",
    },
  };
}

function runFind(
  terminal: VscodeTerminalInstance | null,
  direction: "next" | "previous",
  query: string,
  caseSensitive: boolean,
  regex: boolean,
  setMatched: (matched: boolean) => void,
  setResult: (result: { index: number; count: number }) => void
) {
  const matched =
    direction === "next"
      ? (terminal?.findNext(query, searchOptions(caseSensitive, regex)) ?? false)
      : (terminal?.findPrevious(query, searchOptions(caseSensitive, regex)) ?? false);
  setMatched(matched);
  if (!matched) setResult({ index: -1, count: 0 });
}

function readShellIntegrationMeta(session: SessionInfo): VscodeShellIntegrationMeta | undefined {
  const value = session.meta[VSCODE_SHELL_INTEGRATION_META_KEY];
  return isVscodeShellIntegrationMeta(value) ? value : undefined;
}

function shellIntegrationMetaEqual(
  a: VscodeShellIntegrationMeta | undefined,
  b: VscodeShellIntegrationMeta | undefined
): boolean {
  return a?.status === b?.status
    && a?.cwd === b?.cwd
    && a?.commandLine === b?.commandLine
    && a?.commandRunning === b?.commandRunning
    && a?.lastExitCode === b?.lastExitCode
    && JSON.stringify(a?.shellEnv) === JSON.stringify(b?.shellEnv)
    && a?.shellEnvUpdatedAt === b?.shellEnvUpdatedAt
    && a?.updatedAt === b?.updatedAt;
}
