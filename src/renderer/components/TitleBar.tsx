import {
  Cross2Icon,
  DotsHorizontalIcon,
  HamburgerMenuIcon,
  BoxIcon,
  ViewVerticalIcon,
  ChevronRightIcon,
  DividerVerticalIcon,
  PlusIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ReloadIcon,
  StopIcon,
} from "@radix-ui/react-icons";
import { Badge, Box, Flex, IconButton, Text, TextField, Tooltip } from "@radix-ui/themes";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type RefObject } from "react";
import { useTouchDevice } from "@workspace/react/responsive";

import { useNavigation } from "./NavigationContext";
import type { ChromeCommand } from "./PanelStack";
import { ConnectionStatusBadge } from "./ConnectionStatusBadge";
import { ConnectionSettingsDialog } from "./ConnectionSettingsDialog";

const isMac = process.platform === "darwin";

import type {
  NavigationMode,
  LazyTitleNavigationData,
  LazyStatusNavigationData,
  PanelSummary,
  PanelAncestor,
  DescendantSiblingGroup,
} from "./navigationTypes";
import type { PanelContextMenuAction } from "@natstack/shared/types";
import type { BranchInfo, CommitInfo } from "@natstack/shared/types";
import {
  buildAddressAutocompleteItems,
  type AddressAutocompleteItem,
  type AddressAction,
  type BrowserAddressOptions,
  type PanelAddressOptions,
  type PanelChromeState,
  type PanelSourceSuggestion,
} from "@natstack/shared/panelChrome";
import { getAddressNavigationModeFromModifiers } from "@natstack/shared/panelCommands";
import { menu, panel, type NativeShellOverlayEvent, type NativeShellOverlayOptions } from "../shell/client";
import { useNativeShellOverlay } from "../shell/useNativeShellOverlay";

interface TitleBarProps {
  title: string;
  chromeState?: PanelChromeState | null;
  onChromeCommand?: (command: ChromeCommand) => void;
  onNavigateToId?: (panelId: string) => void;
  onPanelAction?: (panelId: string, action: PanelContextMenuAction) => void;
}

export function TitleBar({ title, chromeState, onChromeCommand, onNavigateToId, onPanelAction }: TitleBarProps) {
  const {
    mode: navigationMode,
    setMode,
    addressBarVisible,
    setAddressBarVisible,
    lazyTitleNavigation: navigationData,
    lazyStatusNavigation: statusNavigation,
  } = useNavigation();
  const [connectionSettingsOpen, setConnectionSettingsOpen] = useState(false);

  const handleNavigationToggle = () => {
    const nextMode: NavigationMode = navigationMode === "stack" ? "tree" : "stack";
    setMode(nextMode);
  };

  const handleHamburgerClick = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    void menu.showHamburger(getWindowPositionFromRect(rect));
  };

  return (
    <Box
      style={
        {
          appRegion: "drag",
          WebkitAppRegion: "drag",
          userSelect: "none",
          height: "32px",
          backgroundColor: "var(--gray-2)",
          borderBottom: "1px solid var(--gray-6)",
        } as CSSProperties
      }
    >
      <Flex align="center" justify="between" height="100%" px="2" gap="2">
        {/* Left side: Hamburger menu */}
        <Flex
          align="center"
          gap="2"
          style={{ appRegion: "no-drag", WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          {/* macOS: spacer for traffic light buttons */}
          {isMac && <Box style={{ width: "78px", flexShrink: 0 }} />}

          <IconButton variant="ghost" size="1" onClick={handleHamburgerClick}>
            <HamburgerMenuIcon />
          </IconButton>

          <Tooltip content={navigationMode === "tree" ? "Breadcrumb mode" : "Tree mode"}>
            <IconButton
              variant="ghost"
              size="1"
              onClick={handleNavigationToggle}
              aria-label={
                navigationMode === "tree"
                  ? "Switch to breadcrumb navigation"
                  : "Switch to tree view"
              }
            >
              {navigationMode === "tree" ? <BoxIcon /> : <ViewVerticalIcon />}
            </IconButton>
          </Tooltip>

          <Tooltip content={addressBarVisible ? "Hide address bar" : "Show address bar"}>
            <IconButton
              variant="ghost"
              size="1"
              onClick={() => setAddressBarVisible(!addressBarVisible)}
              aria-label={addressBarVisible ? "Hide address bar" : "Show address bar"}
            >
              <Text size="1" weight="bold">URL</Text>
            </IconButton>
          </Tooltip>

          <Tooltip content="New panel (Cmd/Ctrl+T)">
            <IconButton
              variant="ghost"
              size="1"
              onClick={async () => {
                const result = await panel.createAboutPanel("new");
                window.dispatchEvent(new CustomEvent("shell-panel-created", {
                  detail: { panelId: result.id }
                }));
              }}
              aria-label="New panel"
            >
              <PlusIcon />
            </IconButton>
          </Tooltip>
        </Flex>

        {/* Center: Navigation + title */}
        <Box
          style={
            {
              flex: 1,
              minWidth: 0,
              overflow: "hidden",
            } as CSSProperties
          }
        >
          {addressBarVisible ? (
            <AddressBar chromeState={chromeState} onChromeCommand={onChromeCommand} />
          ) : (
            <BreadcrumbBar
              title={title}
              navigationData={navigationData}
              statusNavigation={statusNavigation}
              onNavigateToId={onNavigateToId}
              onPanelAction={onPanelAction}
            />
          )}
        </Box>

        {/* Right side: connection badge + spacer for native window controls */}
        <Flex
          align="center"
          gap="1"
          style={{ appRegion: "no-drag", WebkitAppRegion: "no-drag" } as CSSProperties}
        >
          <ConnectionStatusBadge onOpenSettings={() => setConnectionSettingsOpen(true)} />
          {!isMac && <Box style={{ width: "138px" }} />}
        </Flex>
      </Flex>

      <ConnectionSettingsDialog open={connectionSettingsOpen} onOpenChange={setConnectionSettingsOpen} />
    </Box>
  );
}

interface BreadcrumbBarProps {
  title: string;
  navigationData?: LazyTitleNavigationData | null;
  statusNavigation?: LazyStatusNavigationData | null;
  onNavigateToId?: (panelId: string) => void;
  onPanelAction?: (panelId: string, action: PanelContextMenuAction) => void;
}

const MAX_VISIBLE_ANCESTORS = 2;
const MAX_VISIBLE_DESC_GROUPS = 2;

/**
 * Get window-relative position from element bounding rect for native menu positioning.
 * Returns coordinates relative to the window's content area.
 * The main process will handle conversion to screen coordinates.
 */
function getWindowPositionFromRect(rect: DOMRect): { x: number; y: number } {
  return {
    x: Math.round(rect.left),
    y: Math.round(rect.bottom),
  };
}

function AddressBar({
  chromeState,
  onChromeCommand,
}: {
  chromeState?: PanelChromeState | null;
  onChromeCommand?: (command: ChromeCommand) => void;
}) {
  if (chromeState?.kind === "panel") {
    return <PanelAddressBar chromeState={chromeState} onChromeCommand={onChromeCommand} />;
  }

  return <BrowserAddressBar chromeState={chromeState} onChromeCommand={onChromeCommand} />;
}

function BrowserAddressBar({
  chromeState,
  onChromeCommand,
}: {
  chromeState?: PanelChromeState | null;
  onChromeCommand?: (command: ChromeCommand) => void;
}) {
  const [value, setValue] = useState(chromeState?.editableAddress ?? "");
  const [addressOptions, setAddressOptions] = useState<BrowserAddressOptions | null>(null);
  const [focused, setFocused] = useState(false);
  const [overlayBounds, setOverlayBounds] = useState<NativeShellOverlayOptions["bounds"] | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setValue(chromeState?.editableAddress ?? "");
  }, [chromeState?.editableAddress]);

  useEffect(() => {
    if (!focused) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void panel.getBrowserAddressOptions(value)
        .then((options) => {
          if (!cancelled) setAddressOptions(options);
        })
        .catch(() => {
          if (!cancelled) setAddressOptions(null);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [focused, value]);

  useEffect(() => {
    const focusAddress = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("shell-focus-address", focusAddress);
    return () => window.removeEventListener("shell-focus-address", focusAddress);
  }, []);

  const autocompleteItems = useMemo(() => buildAddressAutocompleteItems({
    kind: "browser",
    input: value,
    browserSuggestions: addressOptions?.suggestions,
    limit: 8,
  }), [addressOptions?.suggestions, value]);

  const openOverlay = useCallback((target: HTMLElement | null) => {
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const rowCount = Math.min(Math.max(autocompleteItems.length, 1), 8);
    setOverlayBounds({
      x: Math.round(rect.left),
      y: Math.round(rect.bottom + 4),
      width: Math.max(360, rect.width),
      height: Math.max(52, Math.min(360, 28 + rowCount * 42)),
    });
  }, [autocompleteItems.length]);

  const submitValue = useCallback((nextValue: string, event?: KeyboardEvent<HTMLInputElement>) => {
    if (!nextValue.trim()) return;
    setOverlayBounds(null);
    onChromeCommand?.({
      type: "navigate",
      value: nextValue,
      mode: event ? getAddressNavigationModeFromModifiers(event) : "current",
    });
  }, [onChromeCommand]);

  const overlayHtml = useMemo(() => buildBrowserAddressOverlayHtml(autocompleteItems, value), [autocompleteItems, value]);

  const handleOverlayEvent = useCallback((event: NativeShellOverlayEvent) => {
    const payload = event.payload as { value?: string; action?: AddressAction } | undefined;
    if (event.type === "browser-address-select" && payload?.value) {
      setValue(payload.value);
      if (payload.action) {
        setOverlayBounds(null);
        onChromeCommand?.({ type: "navigate", value: payload.value, action: payload.action });
      } else {
        submitValue(payload.value);
      }
      window.requestAnimationFrame(() => inputRef.current?.blur());
    } else if (event.type === "dismiss") {
      setOverlayBounds(null);
    }
  }, [onChromeCommand, submitValue]);

  useNativeShellOverlay(
    overlayBounds
      ? {
          id: "browser-address-overlay",
          open: true,
          html: overlayHtml,
          bounds: overlayBounds,
          focus: false,
        }
      : null,
    handleOverlayEvent,
  );

  return (
    <Flex
      align="center"
      gap="1"
      style={{ appRegion: "no-drag", WebkitAppRegion: "no-drag", minWidth: 0 } as CSSProperties}
    >
      <Tooltip content="Back">
        <IconButton
          size="1"
          variant="ghost"
          disabled={!chromeState?.canGoBack}
          onClick={() => onChromeCommand?.({ type: "back" })}
          aria-label="Back"
        >
          <ArrowLeftIcon />
        </IconButton>
      </Tooltip>
      <Tooltip content="Forward">
        <IconButton
          size="1"
          variant="ghost"
          disabled={!chromeState?.canGoForward}
          onClick={() => onChromeCommand?.({ type: "forward" })}
          aria-label="Forward"
        >
          <ArrowRightIcon />
        </IconButton>
      </Tooltip>
      <Tooltip content={chromeState?.isLoading ? "Stop" : "Reload"}>
        <IconButton
          size="1"
          variant="ghost"
          onClick={() => onChromeCommand?.({ type: chromeState?.isLoading ? "stop" : "reload-panel" })}
          aria-label={chromeState?.isLoading ? "Stop" : "Reload"}
        >
          {chromeState?.isLoading ? <StopIcon /> : <ReloadIcon />}
        </IconButton>
      </Tooltip>
      <TextField.Root
        ref={inputRef}
        size="1"
        value={value}
        onFocus={(event) => {
          setFocused(true);
          openOverlay(event.currentTarget);
        }}
        onBlur={() => {
          setFocused(false);
          window.setTimeout(() => setOverlayBounds(null), 120);
        }}
        onChange={(event) => {
          setValue(event.currentTarget.value);
          openOverlay(event.currentTarget);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submitValue(value, event);
            inputRef.current?.blur();
          } else if (event.key === "Escape") {
            setOverlayBounds(null);
            setValue(chromeState?.editableAddress ?? "");
            inputRef.current?.blur();
          } else if (event.key === "ArrowDown") {
            event.preventDefault();
            openOverlay(inputRef.current);
          }
        }}
        aria-label="Address"
        style={{ flex: 1, minWidth: 80 }}
      />
    </Flex>
  );
}

type PanelAddressOverlayState =
  | { kind: "path"; bounds: NativeShellOverlayOptions["bounds"] }
  | { kind: "branch"; bounds: NativeShellOverlayOptions["bounds"] }
  | { kind: "commit"; bounds: NativeShellOverlayOptions["bounds"] };

function PanelAddressBar({
  chromeState,
  onChromeCommand,
}: {
  chromeState: PanelChromeState;
  onChromeCommand?: (command: ChromeCommand) => void;
}) {
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const branchButtonRef = useRef<HTMLButtonElement | null>(null);
  const commitButtonRef = useRef<HTMLButtonElement | null>(null);
  const [pathValue, setPathValue] = useState(chromeState.source);
  const [addressOptions, setAddressOptions] = useState<PanelAddressOptions | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string | null>(chromeState.ref ?? chromeState.repo?.branch ?? null);
  const [selectedCommit, setSelectedCommit] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<PanelAddressOverlayState | null>(null);

  useEffect(() => {
    setPathValue(chromeState.source);
    setSelectedBranch(chromeState.ref ?? chromeState.repo?.branch ?? null);
    setSelectedCommit(null);
  }, [chromeState.panelId, chromeState.ref, chromeState.repo?.branch, chromeState.source]);

  useEffect(() => {
    const source = pathValue.trim();
    if (!source) {
      setAddressOptions(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void panel.getAddressOptions(source, selectedBranch ?? undefined)
        .then((options) => {
          if (!cancelled) setAddressOptions(options);
        })
        .catch(() => {
          if (!cancelled) setAddressOptions(null);
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pathValue, selectedBranch]);

  useEffect(() => {
    const focusAddress = () => {
      pathInputRef.current?.focus();
      pathInputRef.current?.select();
    };
    window.addEventListener("shell-focus-address", focusAddress);
    return () => window.removeEventListener("shell-focus-address", focusAddress);
  }, []);

  const branchValue = selectedBranch ?? addressOptions?.repo?.branch ?? chromeState.repo?.branch ?? "HEAD";
  const commitValue = selectedCommit ?? addressOptions?.repo?.commit ?? chromeState.repo?.commit ?? null;
  const commitShort = commitValue ? commitValue.slice(0, 7) : "commit";
  const dirty = addressOptions?.repo?.dirty ?? chromeState.repo?.dirty ?? false;

  const submit = (event?: KeyboardEvent<HTMLInputElement>) => {
    const value = pathValue.trim();
    if (!value) return;
    setOverlay(null);
    onChromeCommand?.({
      type: "navigate",
      value,
      ref: selectedCommit ?? selectedBranch ?? undefined,
      mode: event ? getAddressNavigationModeFromModifiers(event) : "current",
    });
  };

  const openOverlay = useCallback((kind: PanelAddressOverlayState["kind"], target: HTMLElement | null) => {
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const width = kind === "commit" ? Math.max(420, rect.width) : Math.max(320, rect.width);
    const rowCount = kind === "path"
      ? Math.min(addressOptions?.suggestions.length ?? 0, 8)
      : kind === "branch"
        ? Math.min(addressOptions?.branches.length ?? 0, 10)
        : Math.min(addressOptions?.commits.length ?? 0, 10);
    const height = Math.max(52, Math.min(360, 28 + rowCount * 42));
    setOverlay({
      kind,
      bounds: {
        x: Math.round(rect.left),
        y: Math.round(rect.bottom + 4),
        width,
        height,
      },
    });
  }, [addressOptions?.branches.length, addressOptions?.commits.length, addressOptions?.suggestions.length]);

  const overlayHtml = useMemo(() => {
    if (!overlay) return "";
    if (overlay.kind === "path") {
      return buildPathOverlayHtml(addressOptions?.suggestions ?? [], pathValue);
    }
    if (overlay.kind === "branch") {
      return buildBranchOverlayHtml(addressOptions?.branches ?? [], branchValue);
    }
    return buildCommitOverlayHtml(addressOptions?.commits ?? [], commitValue);
  }, [addressOptions?.branches, addressOptions?.commits, addressOptions?.suggestions, branchValue, commitValue, overlay, pathValue]);

  const overlayOptions = overlay
    ? {
        id: "panel-address-overlay",
        open: true,
        html: overlayHtml,
        bounds: overlay.bounds,
        focus: false,
      }
    : null;

  const handleOverlayEvent = useCallback((event: NativeShellOverlayEvent) => {
    const payload = event.payload as { source?: string; branch?: string; commit?: string } | undefined;
    if (event.type === "path-select" && payload?.source) {
      setPathValue(payload.source);
      setSelectedBranch(null);
      setSelectedCommit(null);
      setOverlay(null);
      window.requestAnimationFrame(() => pathInputRef.current?.focus());
    } else if (event.type === "branch-select" && payload?.branch) {
      setSelectedBranch(payload.branch);
      setSelectedCommit(null);
      setOverlay(null);
      window.requestAnimationFrame(() => commitButtonRef.current?.focus());
    } else if (event.type === "commit-select" && payload?.commit) {
      setSelectedCommit(payload.commit);
      setOverlay(null);
      window.requestAnimationFrame(() => pathInputRef.current?.focus());
    } else if (event.type === "dismiss") {
      setOverlay(null);
    }
  }, []);

  useNativeShellOverlay(overlayOptions, handleOverlayEvent);

  const pathInputWidth = `${Math.max(18, Math.min(pathValue.length + 2, 64))}ch`;

  return (
    <Flex
      align="center"
      gap="1"
      style={{ appRegion: "no-drag", WebkitAppRegion: "no-drag", minWidth: 0 } as CSSProperties}
    >
      <Tooltip content="Back">
        <IconButton
          size="1"
          variant="ghost"
          disabled={!chromeState.canGoBack}
          onClick={() => onChromeCommand?.({ type: "back" })}
          aria-label="Back"
        >
          <ArrowLeftIcon />
        </IconButton>
      </Tooltip>
      <Tooltip content="Forward">
        <IconButton
          size="1"
          variant="ghost"
          disabled={!chromeState.canGoForward}
          onClick={() => onChromeCommand?.({ type: "forward" })}
          aria-label="Forward"
        >
          <ArrowRightIcon />
        </IconButton>
      </Tooltip>
      <Tooltip content={chromeState.isLoading ? "Stop" : "Reload"}>
        <IconButton
          size="1"
          variant="ghost"
          onClick={() => onChromeCommand?.({ type: chromeState.isLoading ? "stop" : "reload-panel" })}
          aria-label={chromeState.isLoading ? "Stop" : "Reload"}
        >
          {chromeState.isLoading ? <StopIcon /> : <ReloadIcon />}
        </IconButton>
      </Tooltip>

      <Box
        style={{
          flex: "0 1 auto",
          width: pathInputWidth,
          minWidth: 120,
          maxWidth: "min(100%, 52vw)",
          position: "relative",
        }}
      >
        <TextField.Root
          ref={pathInputRef}
          size="1"
          value={pathValue}
          onFocus={() => openOverlay("path", pathInputRef.current)}
          onChange={(event) => {
            setPathValue(event.currentTarget.value);
            setSelectedBranch(null);
            setSelectedCommit(null);
            openOverlay("path", event.currentTarget);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              submit(event);
              pathInputRef.current?.blur();
            } else if (event.key === "Escape") {
              setOverlay(null);
              setPathValue(chromeState.source);
              pathInputRef.current?.blur();
            } else if (event.key === "ArrowDown") {
              event.preventDefault();
              openOverlay("path", pathInputRef.current);
            }
          }}
          aria-label="Panel path"
          style={{ width: "100%" }}
        />
      </Box>

      <PanelAddressButton
        buttonRef={branchButtonRef}
        label={branchValue}
        disabled={!addressOptions?.branches.length}
        title="Branch"
        onClick={() => openOverlay("branch", branchButtonRef.current)}
      />
      <PanelAddressButton
        buttonRef={commitButtonRef}
        label={commitShort}
        disabled={!addressOptions?.commits.length}
        title="Commit"
        onClick={() => openOverlay("commit", commitButtonRef.current)}
      />
      {dirty && (
        <Badge size="1" color="orange" style={{ flexShrink: 0 }}>
          dirty
        </Badge>
      )}
    </Flex>
  );
}

const PanelAddressButton = ({
  label,
  title,
  disabled,
  onClick,
  buttonRef,
}: {
  label: string;
  title: string;
  disabled?: boolean;
  onClick: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) => (
  <button
    ref={buttonRef}
    type="button"
    disabled={disabled}
    title={title}
    onClick={onClick}
    style={{
      height: 22,
      maxWidth: 140,
      minWidth: 62,
      flexShrink: 0,
      border: "1px solid var(--gray-6)",
      borderRadius: 4,
      background: disabled ? "var(--gray-3)" : "var(--gray-1)",
      color: disabled ? "var(--gray-9)" : "var(--gray-12)",
      font: "inherit",
      fontSize: 12,
      padding: "0 8px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
      cursor: disabled ? "default" : "pointer",
    }}
  >
    {label}
  </button>
);

function buildPathOverlayHtml(suggestions: PanelSourceSuggestion[], query: string): string {
  const rows = buildAddressAutocompleteItems({
    kind: "panel",
    input: query,
    panelSuggestions: suggestions,
    limit: 8,
  }).map((item) => ({
    label: item.label,
    meta: item.meta,
    payload: { source: item.value },
    type: "path-select",
  }));
  return buildListOverlayHtml({
    empty: query ? "No matching panels" : "Start typing a panel path",
    rows,
  });
}

function buildBrowserAddressOverlayHtml(items: AddressAutocompleteItem[], query: string): string {
  const rows = items.slice(0, 8).map((item) => ({
    label: item.label,
    meta: item.meta,
    labelRanges: item.matchRanges?.label,
    metaRanges: item.matchRanges?.meta,
    icon: item.iconKind,
    payload: { value: item.value, action: item.action },
    type: "browser-address-select",
  }));
  return buildListOverlayHtml({
    empty: query ? "No matching history" : "No browser history yet",
    rows,
  });
}

function buildBranchOverlayHtml(branches: BranchInfo[], selected: string): string {
  const rows = branches.slice(0, 40).map((branch) => ({
    label: branch.name,
    meta: branch.current ? "current branch" : "branch",
    selected: branch.name === selected,
    payload: { branch: branch.name },
    type: "branch-select",
  }));
  return buildListOverlayHtml({ empty: "No branches found", rows });
}

function buildCommitOverlayHtml(commits: CommitInfo[], selected: string | null): string {
  const rows = commits.slice(0, 50).map((commit) => ({
    label: `${commit.oid.slice(0, 7)} ${commit.message}`,
    meta: commit.author.name,
    selected: commit.oid === selected,
    payload: { commit: commit.oid },
    type: "commit-select",
  }));
  return buildListOverlayHtml({ empty: "No commits found", rows });
}

function buildListOverlayHtml(args: {
  empty: string;
  rows: Array<{
    label: string;
    meta?: string;
    labelRanges?: Array<{ start: number; end: number }>;
    metaRanges?: Array<{ start: number; end: number }>;
    icon?: string;
    selected?: boolean;
    type: string;
    payload: Record<string, unknown>;
  }>;
}): string {
  const rowsJson = JSON.stringify(args.rows).replace(/</g, "\\u003c");
  const emptyJson = JSON.stringify(args.empty).replace(/</g, "\\u003c");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<style>
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
.panel { margin: 0; border: 1px solid #d7d7dc; border-radius: 6px; overflow: hidden; background: #fff; color: #1f1f24; box-shadow: 0 8px 22px rgba(0,0,0,.18); }
.row { width: 100%; border: 0; border-bottom: 1px solid #eeeeef; background: transparent; text-align: left; padding: 7px 10px; cursor: pointer; display: block; color: inherit; }
.row:last-child { border-bottom: 0; }
.row:hover, .row:focus, .row[data-selected="true"] { background: #edf4ff; outline: none; }
.row-inner { display: flex; gap: 8px; align-items: center; min-width: 0; }
.icon { width: 16px; flex: 0 0 16px; text-align: center; color: #6f6f77; font-size: 12px; }
.text { min-width: 0; flex: 1; }
.label { font-size: 12px; line-height: 16px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.meta { margin-top: 1px; font-size: 11px; line-height: 14px; color: #6f6f77; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.match { font-weight: 700; color: #0b57d0; }
.empty { padding: 12px; font-size: 12px; color: #6f6f77; }
@media (prefers-color-scheme: dark) {
  .panel { background: #202024; border-color: #3b3b42; color: #f0f0f3; box-shadow: 0 8px 22px rgba(0,0,0,.45); }
  .row { border-bottom-color: #303038; }
  .row:hover, .row:focus, .row[data-selected="true"] { background: #28364d; }
  .meta, .empty { color: #a5a5ad; }
  .match { color: #8ab4ff; }
}
</style>
</head>
<body>
<div class="panel" role="listbox" id="panel"></div>
<script>
const rows = ${rowsJson};
const emptyText = ${emptyJson};
const panel = document.getElementById("panel");
if (!rows.length) {
  panel.innerHTML = '<div class="empty">' + escapeHtml(emptyText) + '</div>';
} else {
  panel.innerHTML = rows.map((row, index) => '<button class="row" data-index="' + index + '" data-selected="' + Boolean(row.selected) + '" type="button"><div class="row-inner">' + (row.icon ? '<div class="icon">' + escapeHtml(iconText(row.icon)) + '</div>' : '') + '<div class="text"><div class="label">' + renderMatchedText(row.label, row.labelRanges) + '</div>' + (row.meta ? '<div class="meta">' + renderMatchedText(row.meta, row.metaRanges) + '</div>' : '') + '</div></div></button>').join('');
  panel.querySelectorAll(".row").forEach((button) => {
    button.addEventListener("click", () => {
      const row = rows[Number(button.dataset.index)];
      window.__natstack_shell_overlay.emit(row.type, row.payload);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter") button.click();
      if (event.key === "Tab") { event.preventDefault(); button.click(); }
      if (event.key === "Escape") window.__natstack_shell_overlay.emit("dismiss");
      if (event.key === "ArrowDown") {
        event.preventDefault();
        (button.nextElementSibling || panel.querySelector(".row"))?.focus();
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        (button.previousElementSibling || panel.querySelector(".row:last-child"))?.focus();
      }
    });
  });
}
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") window.__natstack_shell_overlay.emit("dismiss");
});
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}
function renderMatchedText(value, ranges) {
  const text = String(value);
  if (!Array.isArray(ranges) || !ranges.length) return escapeHtml(text);
  let cursor = 0;
  let html = "";
  ranges
    .map((range) => ({ start: Math.max(0, Math.min(text.length, Number(range.start))), end: Math.max(0, Math.min(text.length, Number(range.end))) }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start)
    .forEach((range) => {
      if (range.start < cursor) return;
      if (range.start > cursor) html += escapeHtml(text.slice(cursor, range.start));
      html += '<span class="match">' + escapeHtml(text.slice(range.start, range.end)) + '</span>';
      cursor = range.end;
    });
  if (cursor < text.length) html += escapeHtml(text.slice(cursor));
  return html;
}
function iconText(kind) {
  return ({ globe: "go", history: "h", bookmark: "*", search: "?", session: "s", panel: "p", branch: "br", commit: "c" })[kind] || "-";
}
</script>
</body>
</html>`;
}

// Shared styles for breadcrumb items
const itemStyle: CSSProperties = {
  appRegion: "no-drag",
  WebkitAppRegion: "no-drag",
  padding: "2px 6px",
  borderRadius: "3px",
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background-color 100ms",
} as CSSProperties;

// Style for sibling group container
const groupStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "1px",
  padding: "1px",
  borderRadius: "4px",
  border: "1px solid var(--gray-6)",
  appRegion: "no-drag",
  WebkitAppRegion: "no-drag",
} as CSSProperties;

// Hoverable breadcrumb item with X button on hover
interface HoverableBreadcrumbItemProps {
  panelId: string;
  title: string;
  isActive: boolean;
  isCurrent: boolean;
  onNavigate: () => void;
  onContextMenu: (e: MouseEvent<HTMLSpanElement>) => void;
}

function HoverableBreadcrumbItem({
  panelId,
  title,
  isActive,
  isCurrent,
  onNavigate,
  onContextMenu,
}: HoverableBreadcrumbItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const isTouch = useTouchDevice();

  const archivePanel = () => {
    void menu.archivePanel(panelId).catch((error) => {
      console.error("Failed to archive panel from title bar", error);
    });
  };

  const handleArchive = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    archivePanel();
  };

  return (
    <span
      style={{
        position: "relative",
        ...itemStyle,
        backgroundColor: isCurrent && isActive ? "var(--gray-a4)" : isHovered ? "var(--gray-a3)" : undefined,
      }}
      onClick={onNavigate}
      onContextMenu={onContextMenu}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <Text
        as="span"
        size="2"
        color={isActive ? undefined : "gray"}
        style={{ whiteSpace: "nowrap" }}
      >
        {title}
      </Text>
      {(isHovered || isTouch) && (
        <IconButton
          size="1"
          variant="ghost"
          color="gray"
          radius="small"
          aria-label="Archive panel"
          onClick={handleArchive}
          className="breadcrumb-archive-btn"
          style={{
            appRegion: "no-drag",
            WebkitAppRegion: "no-drag",
            position: "absolute",
            right: 2,
            top: "50%",
            transform: "translateY(-50%)",
            width: 16,
            height: 16,
            padding: 0,
            opacity: 0.6,
          } as CSSProperties}
        >
          <Cross2Icon width={10} height={10} />
        </IconButton>
      )}
    </span>
  );
}

function BreadcrumbBar({
  title,
  navigationData,
  statusNavigation,
  onNavigateToId,
  onPanelAction,
}: BreadcrumbBarProps) {
  const ancestors = navigationData?.ancestors ?? [];
  const currentSiblings = navigationData?.currentSiblings ?? [];
  const descendantGroups = statusNavigation?.descendantGroups ?? [];

  const visibleAncestors = ancestors.slice(-MAX_VISIBLE_ANCESTORS);
  const hiddenAncestors = ancestors.slice(0, ancestors.length - visibleAncestors.length);

  const visibleDescendantGroups = descendantGroups.slice(0, MAX_VISIBLE_DESC_GROUPS);
  const hiddenDescendantGroups = descendantGroups.slice(visibleDescendantGroups.length);

  const handlePanelContextMenu = async (
    e: MouseEvent<HTMLSpanElement>,
    panel: PanelSummary | PanelAncestor
  ) => {
    e.preventDefault();
    const rect = e.currentTarget.getBoundingClientRect();
    const action = await menu.showPanelContext(panel.id, getWindowPositionFromRect(rect));
    if (action) {
      onPanelAction?.(panel.id, action);
    }
  };

  const renderBreadcrumbItem = (
    panel: PanelSummary,
    isActive: boolean,
    isCurrent: boolean
  ) => (
    <HoverableBreadcrumbItem
      key={panel.id}
      panelId={panel.id}
      title={panel.title}
      isActive={isActive}
      isCurrent={isCurrent}
      onNavigate={() => onNavigateToId?.(panel.id)}
      onContextMenu={(e) => handlePanelContextMenu(e, panel)}
    />
  );

  const renderAncestorItem = (ancestor: PanelAncestor) => (
    <HoverableBreadcrumbItem
      key={ancestor.id}
      panelId={ancestor.id}
      title={ancestor.title}
      isActive={true}
      isCurrent={false}
      onNavigate={() => onNavigateToId?.(ancestor.id)}
      onContextMenu={(e) => handlePanelContextMenu(e, ancestor)}
    />
  );

  const renderSiblingGroup = (
    siblings: PanelSummary[],
    activeId: string | null,
    isCurrent: boolean
  ) => {
    if (siblings.length === 0) return null;
    const effectiveActiveId = activeId || siblings[0]?.id || "";

    return (
      <span style={groupStyle}>
        {siblings.map((sibling, index) => (
          <span key={sibling.id} style={{ display: "inline-flex", alignItems: "center" }}>
            {index > 0 && (
              <DividerVerticalIcon
                style={{ color: "var(--gray-7)", width: 12, height: 12, flexShrink: 0 }}
              />
            )}
            {renderBreadcrumbItem(
              sibling,
              sibling.id === effectiveActiveId,
              isCurrent
            )}
          </span>
        ))}
      </span>
    );
  };

  const handleHiddenAncestorsClick = async (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const items = hiddenAncestors.map((ancestor) => ({
      id: ancestor.id,
      label: ancestor.title,
    }));
    const selected = await menu.showContext(items, getWindowPositionFromRect(rect));
    if (selected !== null) {
      onNavigateToId?.(selected);
    }
  };

  const handleHiddenDescendantsClick = async (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    // For hidden descendant groups, show the selected panel from each group
    const items = hiddenDescendantGroups.map((group) => {
      const selectedPanel = group.siblings.find((s) => s.id === group.selectedId);
      return {
        id: group.selectedId,
        label: selectedPanel?.title ?? "Unknown",
      };
    });
    const selected = await menu.showContext(items, getWindowPositionFromRect(rect));
    if (selected !== null) {
      onNavigateToId?.(selected);
    }
  };

  const renderDescendantSiblingGroup = (group: DescendantSiblingGroup) => {
    if (group.siblings.length === 0) return null;

    return (
      <span style={groupStyle}>
        {group.siblings.map((sibling, index) => (
          <span key={sibling.id} style={{ display: "inline-flex", alignItems: "center" }}>
            {index > 0 && (
              <DividerVerticalIcon
                style={{ color: "var(--gray-7)", width: 12, height: 12, flexShrink: 0 }}
              />
            )}
            {renderBreadcrumbItem(
              sibling,
              sibling.id === group.selectedId,
              false
            )}
          </span>
        ))}
      </span>
    );
  };

  return (
    <Flex align="center" gap="1" style={{ minWidth: 0, overflow: "hidden" } as CSSProperties}>
      {/* Ancestors */}
      {hiddenAncestors.length > 0 && (
        <>
          <IconButton
            size="1"
            variant="ghost"
            aria-label="More ancestors"
            onClick={handleHiddenAncestorsClick}
            style={{ appRegion: "no-drag", WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <DotsHorizontalIcon />
          </IconButton>
          <ChevronRightIcon color="var(--gray-8)" />
        </>
      )}
      {visibleAncestors.map((ancestor) => (
        <Flex key={ancestor.id} align="center" gap="1">
          <span style={groupStyle}>
            {renderAncestorItem(ancestor)}
          </span>
          <ChevronRightIcon color="var(--gray-8)" />
        </Flex>
      ))}

      {/* Current (with siblings) */}
      {currentSiblings.length > 0 ? (
        renderSiblingGroup(
          currentSiblings,
          navigationData?.currentId ?? null,
          true
        )
      ) : (
        <span style={groupStyle}>
          <Text
            size="2"
            style={{ ...itemStyle, backgroundColor: "var(--gray-a4)" }}
          >
            {navigationData?.currentTitle ?? title}
          </Text>
        </span>
      )}

      {/* Descendants (sibling groups) */}
      {visibleDescendantGroups.map((group) => (
        <Flex key={`desc-${group.depth}`} align="center" gap="1">
          <ChevronRightIcon color="var(--gray-8)" />
          {renderDescendantSiblingGroup(group)}
        </Flex>
      ))}
      {hiddenDescendantGroups.length > 0 && (
        <>
          <ChevronRightIcon color="var(--gray-8)" />
          <IconButton
            size="1"
            variant="ghost"
            aria-label="More descendants"
            onClick={handleHiddenDescendantsClick}
            style={{ appRegion: "no-drag", WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <DotsHorizontalIcon />
          </IconButton>
        </>
      )}
    </Flex>
  );
}
