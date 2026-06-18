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
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import { useIsMobile, useTouchDevice } from "@workspace/react/responsive";

import { useNavigation } from "./NavigationContext";
import type { ChromeCommand } from "./PanelStack";
import { ConnectionStatusBadge } from "./ConnectionStatusBadge";
import { ConnectionSettingsDialog } from "./ConnectionSettingsDialog";

const isMac = /\b(Mac|iPhone|iPad|iPod)\b/.test(globalThis.navigator?.platform ?? "");

import type {
  NavigationMode,
  LazyTitleNavigationData,
  LazyStatusNavigationData,
  PanelSummary,
  PanelAncestor,
  DescendantSiblingGroup,
} from "./navigationTypes";
import type { PanelContextMenuAction } from "@natstack/shared/types";
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
import {
  menu,
  panel,
  type NativeShellOverlayEvent,
  type NativeShellOverlayOptions,
  type ShellOverlayRow,
} from "../shell/client";
import { useNativeShellOverlay } from "../shell/useNativeShellOverlay";

interface TitleBarProps {
  title: string;
  chromeState?: PanelChromeState | null;
  onChromeCommand?: (command: ChromeCommand) => void;
  onNavigateToId?: (panelId: string) => void;
  onPanelAction?: (panelId: string, action: PanelContextMenuAction) => void;
}

export function TitleBar({
  title,
  chromeState,
  onChromeCommand,
  onNavigateToId,
  onPanelAction,
}: TitleBarProps) {
  const {
    mode: navigationMode,
    setMode,
    addressBarVisible,
    setAddressBarVisible,
    lazyTitleNavigation: navigationData,
    lazyStatusNavigation: statusNavigation,
  } = useNavigation();
  const [connectionSettingsOpen, setConnectionSettingsOpen] = useState(false);
  const isMobile = useIsMobile();

  const handleNavigationToggle = () => {
    const nextMode: NavigationMode = navigationMode === "stack" ? "tree" : "stack";
    setMode(nextMode);
  };

  // Address-bar commands: after a navigate (Enter or picking a suggestion),
  // return to breadcrumb view. Browser controls (back/forward/reload) stay put.
  const handleAddressChromeCommand = (command: ChromeCommand) => {
    onChromeCommand?.(command);
    if (command.type === "navigate") {
      setAddressBarVisible(false);
    }
  };

  const handleHamburgerClick = (e: MouseEvent<HTMLButtonElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    void menu.showHamburger(getWindowPositionFromRect(rect));
  };

  if (isMobile) {
    return (
      <Box
        data-shell-top-chrome="titlebar"
        style={
          {
            appRegion: "drag",
            WebkitAppRegion: "drag",
            userSelect: "none",
            backgroundColor: "var(--app-chrome-bg)",
            borderBottom: "1px solid var(--app-chrome-border)",
          } as CSSProperties
        }
      >
        <Flex align="center" justify="between" height="44px" px="2" gap="2">
          <Flex
            align="center"
            gap="1"
            style={{ appRegion: "no-drag", WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <IconButton variant="ghost" size="2" onClick={handleHamburgerClick} aria-label="Menu">
              <HamburgerMenuIcon />
            </IconButton>

            <Tooltip content={navigationMode === "tree" ? "Close panel tree" : "Open panel tree"}>
              <IconButton
                variant="ghost"
                size="2"
                onClick={handleNavigationToggle}
                aria-label={navigationMode === "tree" ? "Close panel tree" : "Open panel tree"}
              >
                {navigationMode === "tree" ? <BoxIcon /> : <ViewVerticalIcon />}
              </IconButton>
            </Tooltip>
          </Flex>

          <Box
            onClick={() => setAddressBarVisible(true)}
            title="Edit address"
            style={
              {
                flex: 1,
                minWidth: 0,
                appRegion: "no-drag",
                WebkitAppRegion: "no-drag",
                cursor: "text",
              } as CSSProperties
            }
          >
            <Text size="2" weight="medium" truncate style={{ width: "100%", textAlign: "center" }}>
              {title}
            </Text>
          </Box>

          <Flex
            align="center"
            gap="1"
            style={{ appRegion: "no-drag", WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <Tooltip content="New panel">
              <IconButton
                variant="ghost"
                size="2"
                onClick={async () => {
                  const result = await panel.createAboutPanel("new");
                  window.dispatchEvent(
                    new CustomEvent("shell-panel-created", {
                      detail: { panelId: result.id },
                    })
                  );
                }}
                aria-label="New panel"
              >
                <PlusIcon />
              </IconButton>
            </Tooltip>
            <ConnectionStatusBadge onOpenSettings={() => setConnectionSettingsOpen(true)} />
          </Flex>
        </Flex>

        {addressBarVisible && (
          <Box
            px="2"
            pb="2"
            style={{ appRegion: "no-drag", WebkitAppRegion: "no-drag" } as CSSProperties}
          >
            <Flex align="center" gap="1">
              <Box style={{ flex: 1, minWidth: 0 }}>
                <AddressBar
                  chromeState={chromeState}
                  onChromeCommand={handleAddressChromeCommand}
                />
              </Box>
              <Tooltip content="Back to breadcrumbs">
                <IconButton
                  variant="ghost"
                  size="2"
                  onClick={() => setAddressBarVisible(false)}
                  aria-label="Back to breadcrumbs"
                >
                  <Cross2Icon />
                </IconButton>
              </Tooltip>
            </Flex>
          </Box>
        )}

        <ConnectionSettingsDialog
          open={connectionSettingsOpen}
          onOpenChange={setConnectionSettingsOpen}
        />
      </Box>
    );
  }

  return (
    <Box
      data-shell-top-chrome="titlebar"
      style={
        {
          appRegion: "drag",
          WebkitAppRegion: "drag",
          userSelect: "none",
          height: "32px",
          backgroundColor: "var(--app-chrome-bg)",
          borderBottom: "1px solid var(--app-chrome-border)",
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

          <Tooltip content="New panel (Cmd/Ctrl+T)">
            <IconButton
              variant="ghost"
              size="1"
              onClick={async () => {
                const result = await panel.createAboutPanel("new");
                window.dispatchEvent(
                  new CustomEvent("shell-panel-created", {
                    detail: { panelId: result.id },
                  })
                );
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
            <Flex
              align="center"
              gap="1"
              style={
                { width: "100%", appRegion: "no-drag", WebkitAppRegion: "no-drag" } as CSSProperties
              }
            >
              <Box style={{ flex: 1, minWidth: 0 }}>
                <AddressBar
                  chromeState={chromeState}
                  onChromeCommand={handleAddressChromeCommand}
                />
              </Box>
              <Tooltip content="Back to breadcrumbs">
                <IconButton
                  variant="ghost"
                  size="1"
                  onClick={() => setAddressBarVisible(false)}
                  aria-label="Back to breadcrumbs"
                >
                  <Cross2Icon />
                </IconButton>
              </Tooltip>
            </Flex>
          ) : (
            <BreadcrumbBar
              title={title}
              navigationData={navigationData}
              statusNavigation={statusNavigation}
              onNavigateToId={onNavigateToId}
              onPanelAction={onPanelAction}
              onEditAddress={() => setAddressBarVisible(true)}
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

      <ConnectionSettingsDialog
        open={connectionSettingsOpen}
        onOpenChange={setConnectionSettingsOpen}
      />
    </Box>
  );
}

interface BreadcrumbBarProps {
  title: string;
  navigationData?: LazyTitleNavigationData | null;
  statusNavigation?: LazyStatusNavigationData | null;
  onNavigateToId?: (panelId: string) => void;
  onPanelAction?: (panelId: string, action: PanelContextMenuAction) => void;
  /** Clicking the already-active breadcrumb switches to the address/controls view. */
  onEditAddress?: () => void;
}

const MAX_VISIBLE_ANCESTORS = 2;
const MAX_VISIBLE_DESC_GROUPS = 2;
const MAX_VISIBLE_SIBLINGS_PER_GROUP = 7;
const MIN_VISIBLE_SIBLINGS_PER_GROUP = 4;
const ESTIMATED_BREADCRUMB_ITEM_WIDTH = 108;

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
  const isMobile = useIsMobile();
  const [value, setValue] = useState(chromeState?.editableAddress ?? "");
  const [addressOptions, setAddressOptions] = useState<BrowserAddressOptions | null>(null);
  const [focused, setFocused] = useState(false);
  const [overlayBounds, setOverlayBounds] = useState<NativeShellOverlayOptions["bounds"] | null>(
    null
  );
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setValue(chromeState?.editableAddress ?? "");
  }, [chromeState?.editableAddress]);

  useEffect(() => {
    if (!focused) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void panel
        .getBrowserAddressOptions(value)
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

  const autocompleteItems = useMemo(
    () =>
      buildAddressAutocompleteItems({
        kind: "browser",
        input: value,
        browserSuggestions: addressOptions?.suggestions,
        limit: 8,
      }),
    [addressOptions?.suggestions, value]
  );

  const openOverlay = useCallback(
    (target: HTMLElement | null) => {
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const rowCount = Math.min(Math.max(autocompleteItems.length, 1), 8);
      const maxOverlayWidth =
        typeof window === "undefined" ? rect.width : Math.max(240, window.innerWidth - 16);
      setOverlayBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.bottom + 4),
        width: Math.min(maxOverlayWidth, Math.max(isMobile ? 240 : 360, rect.width)),
        height: Math.max(52, Math.min(360, 28 + rowCount * 42)),
      });
    },
    [autocompleteItems.length, isMobile]
  );

  // Resize the overlay as suggestions stream in (they load async after openOverlay).
  // Depend on the open *boolean* (not the bounds object) to avoid a render loop;
  // openOverlay's identity changes with the row count, which re-runs this.
  const isBrowserOverlayOpen = overlayBounds !== null;
  useEffect(() => {
    if (focused && isBrowserOverlayOpen) openOverlay(inputRef.current);
  }, [focused, isBrowserOverlayOpen, openOverlay]);

  const submitValue = useCallback(
    (nextValue: string, event?: KeyboardEvent<HTMLInputElement>) => {
      if (!nextValue.trim()) return;
      setOverlayBounds(null);
      onChromeCommand?.({
        type: "navigate",
        value: nextValue,
        mode: event ? getAddressNavigationModeFromModifiers(event) : "current",
      });
    },
    [onChromeCommand]
  );

  const overlayData = useMemo(
    () => buildBrowserAddressRows(autocompleteItems, value),
    [autocompleteItems, value]
  );

  const handleOverlayEvent = useCallback(
    (event: NativeShellOverlayEvent) => {
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
    },
    [onChromeCommand, submitValue]
  );

  useNativeShellOverlay(
    overlayBounds
      ? {
          id: "browser-address-overlay",
          open: true,
          rows: overlayData.rows,
          empty: overlayData.empty,
          bounds: overlayBounds,
          focus: false,
        }
      : null,
    handleOverlayEvent
  );

  return (
    <Flex
      align="center"
      gap="1"
      style={
        {
          appRegion: "no-drag",
          WebkitAppRegion: "no-drag",
          minWidth: 0,
          width: "100%",
        } as CSSProperties
      }
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
      {!isMobile && (
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
      )}
      <Tooltip content={chromeState?.isLoading ? "Stop" : "Reload"}>
        <IconButton
          size="1"
          variant="ghost"
          onClick={() =>
            onChromeCommand?.({ type: chromeState?.isLoading ? "stop" : "reload-panel" })
          }
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
        style={{ flex: 1, minWidth: 0 }}
      />
    </Flex>
  );
}

type PanelAddressOverlayState = { kind: "path"; bounds: NativeShellOverlayOptions["bounds"] };

function PanelAddressBar({
  chromeState,
  onChromeCommand,
}: {
  chromeState: PanelChromeState;
  onChromeCommand?: (command: ChromeCommand) => void;
}) {
  const isMobile = useIsMobile();
  const pathInputRef = useRef<HTMLInputElement | null>(null);
  const [pathValue, setPathValue] = useState(chromeState.source);
  const [addressOptions, setAddressOptions] = useState<PanelAddressOptions | null>(null);
  const [overlay, setOverlay] = useState<PanelAddressOverlayState | null>(null);

  useEffect(() => {
    setPathValue(chromeState.source);
  }, [chromeState.panelId, chromeState.source]);

  useEffect(() => {
    const source = pathValue.trim();
    if (!source) {
      setAddressOptions(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void panel
        .getAddressOptions(source, chromeState.ref)
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
  }, [chromeState.ref, pathValue]);

  useEffect(() => {
    const focusAddress = () => {
      pathInputRef.current?.focus();
      pathInputRef.current?.select();
    };
    window.addEventListener("shell-focus-address", focusAddress);
    return () => window.removeEventListener("shell-focus-address", focusAddress);
  }, []);

  const dirty = addressOptions?.repo?.dirty ?? chromeState.repo?.dirty ?? false;

  const submit = (event?: KeyboardEvent<HTMLInputElement>) => {
    const value = pathValue.trim();
    if (!value) return;
    setOverlay(null);
    onChromeCommand?.({
      type: "navigate",
      value,
      ref: chromeState.ref,
      mode: event ? getAddressNavigationModeFromModifiers(event) : "current",
    });
  };

  const openOverlay = useCallback(
    (kind: PanelAddressOverlayState["kind"], target: HTMLElement | null) => {
      if (!target) return;
      const rect = target.getBoundingClientRect();
      const preferredWidth = Math.max(isMobile ? 260 : 320, rect.width);
      const maxOverlayWidth =
        typeof window === "undefined" ? preferredWidth : Math.max(240, window.innerWidth - 16);
      const rowCount = Math.min(addressOptions?.suggestions.length ?? 0, 8);
      const height = Math.max(52, Math.min(360, 28 + rowCount * 42));
      setOverlay({
        kind,
        bounds: {
          x: Math.round(rect.left),
          y: Math.round(rect.bottom + 4),
          width: Math.min(maxOverlayWidth, preferredWidth),
          height,
        },
      });
    },
    [addressOptions?.suggestions.length, isMobile]
  );

  // Resize the overlay as suggestions stream in (loaded async after openOverlay).
  const isPanelOverlayOpen = overlay !== null;
  useEffect(() => {
    if (isPanelOverlayOpen) openOverlay("path", pathInputRef.current);
  }, [isPanelOverlayOpen, openOverlay]);

  const overlayData = useMemo(
    () => buildPathRows(addressOptions?.suggestions ?? [], pathValue),
    [addressOptions?.suggestions, pathValue]
  );

  const overlayOptions = overlay
    ? {
        id: "panel-address-overlay",
        open: true,
        rows: overlayData.rows,
        empty: overlayData.empty,
        bounds: overlay.bounds,
        focus: false,
      }
    : null;

  const handleOverlayEvent = useCallback(
    (event: NativeShellOverlayEvent) => {
      const payload = event.payload as { source?: string } | undefined;
      if (event.type === "path-select" && payload?.source) {
        setPathValue(payload.source);
        setOverlay(null);
        onChromeCommand?.({
          type: "navigate",
          value: payload.source,
          ref: chromeState.ref,
          mode: "current",
        });
      } else if (event.type === "dismiss") {
        setOverlay(null);
      }
    },
    [onChromeCommand, chromeState.ref]
  );

  useNativeShellOverlay(overlayOptions, handleOverlayEvent);

  return (
    <Flex
      align="center"
      gap="1"
      style={
        {
          appRegion: "no-drag",
          WebkitAppRegion: "no-drag",
          minWidth: 0,
          width: "100%",
          flexWrap: isMobile ? "wrap" : "nowrap",
          rowGap: 4,
        } as CSSProperties
      }
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
      {!isMobile && (
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
      )}
      <Tooltip content={chromeState.isLoading ? "Stop" : "Reload"}>
        <IconButton
          size="1"
          variant="ghost"
          onClick={() =>
            onChromeCommand?.({ type: chromeState.isLoading ? "stop" : "reload-panel" })
          }
          aria-label={chromeState.isLoading ? "Stop" : "Reload"}
        >
          {chromeState.isLoading ? <StopIcon /> : <ReloadIcon />}
        </IconButton>
      </Tooltip>

      <Box
        style={{
          flex: 1,
          minWidth: isMobile ? 0 : 120,
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

      {dirty && (
        <Badge size="1" color="orange" style={{ flexShrink: 0 }}>
          dirty
        </Badge>
      )}
    </Flex>
  );
}

function buildPathRows(
  suggestions: PanelSourceSuggestion[],
  query: string
): { rows: ShellOverlayRow[]; empty: string } {
  const rows: ShellOverlayRow[] = buildAddressAutocompleteItems({
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
  return { rows, empty: query ? "No matching panels" : "Start typing a panel path" };
}

function buildBrowserAddressRows(
  items: AddressAutocompleteItem[],
  query: string
): { rows: ShellOverlayRow[]; empty: string } {
  const rows: ShellOverlayRow[] = items.slice(0, 8).map((item) => ({
    label: item.label,
    meta: item.meta,
    labelRanges: item.matchRanges?.label,
    metaRanges: item.matchRanges?.meta,
    icon: item.iconKind,
    payload: { value: item.value, action: item.action },
    type: "browser-address-select",
  }));
  return { rows, empty: query ? "No matching history" : "No browser history yet" };
}

// Shared styles for breadcrumb items
const itemStyle: CSSProperties = {
  appRegion: "no-drag",
  WebkitAppRegion: "no-drag",
  display: "inline-flex",
  alignItems: "center",
  border: "1px solid transparent",
  minWidth: 0,
  maxWidth: "clamp(72px, 16vw, 180px)",
  padding: "2px 6px",
  borderRadius: "3px",
  cursor: "pointer",
  whiteSpace: "nowrap",
  transition: "background-color 100ms",
} as CSSProperties;

// Style for sibling group container. Border kept transparent (width preserved
// to avoid layout shift) so breadcrumb groups don't read as boxed tab groups —
// the only frame is the slight one on the current breadcrumb item itself.
const groupStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "1px",
  minWidth: 0,
  maxWidth: "100%",
  flexShrink: 0,
  padding: "1px",
  borderRadius: "4px",
  border: "1px solid transparent",
  appRegion: "drag",
  WebkitAppRegion: "drag",
} as CSSProperties;

// Hoverable breadcrumb item with X button on hover
interface HoverableBreadcrumbItemProps {
  panelId: string;
  title: string;
  isActive: boolean;
  isCurrent: boolean;
  onNavigate: () => void;
  onContextMenu: (e: MouseEvent<HTMLSpanElement>) => void;
  onEditAddress?: () => void;
}

function HoverableBreadcrumbItem({
  panelId,
  title,
  isActive,
  isCurrent,
  onNavigate,
  onContextMenu,
  onEditAddress,
}: HoverableBreadcrumbItemProps) {
  const [isHovered, setIsHovered] = useState(false);
  const isTouch = useTouchDevice();

  // Clicking the already-active breadcrumb opens the address/controls view;
  // any other breadcrumb navigates to that panel.
  const isCurrentActive = isCurrent && isActive;
  const handleActivate = () => {
    if (isCurrentActive && onEditAddress) {
      onEditAddress();
    } else {
      onNavigate();
    }
  };

  const archivePanel = () => {
    void panel.archive(panelId).catch((error) => {
      console.error("Failed to archive panel from title bar", error);
    });
  };

  const handleArchive = (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    archivePanel();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLSpanElement>) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    handleActivate();
  };

  return (
    <Tooltip content={title}>
      <span
        role="button"
        tabIndex={0}
        data-breadcrumb-focusable="true"
        data-breadcrumb-id={panelId}
        data-breadcrumb-current={isCurrentActive ? "true" : undefined}
        title={isCurrentActive ? "Edit address" : undefined}
        style={{
          position: "relative",
          ...itemStyle,
          // Breadcrumb look (not tabs): no per-item background fills, just a
          // slight frame around the current breadcrumb.
          borderColor: isCurrentActive ? "var(--accent-7)" : "transparent",
          backgroundColor: isHovered ? "var(--gray-a3)" : undefined,
          color: isCurrentActive ? "var(--accent-12)" : undefined,
        }}
        onClick={handleActivate}
        onContextMenu={onContextMenu}
        onKeyDown={handleKeyDown}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        <Text
          as="span"
          size="2"
          color={isActive ? undefined : "gray"}
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
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
            style={
              {
                appRegion: "no-drag",
                WebkitAppRegion: "no-drag",
                position: "absolute",
                right: 2,
                top: "50%",
                transform: "translateY(-50%)",
                width: 16,
                height: 16,
                padding: 0,
                opacity: 0.75,
              } as CSSProperties
            }
          >
            <Cross2Icon width={10} height={10} />
          </IconButton>
        )}
      </span>
    </Tooltip>
  );
}

function getVisibleSiblingLimit(width: number): number {
  if (width <= 0) return MAX_VISIBLE_SIBLINGS_PER_GROUP;
  return Math.max(
    MIN_VISIBLE_SIBLINGS_PER_GROUP,
    Math.min(
      MAX_VISIBLE_SIBLINGS_PER_GROUP + 5,
      Math.floor(width / ESTIMATED_BREADCRUMB_ITEM_WIDTH)
    )
  );
}

function getFocusableBreadcrumbItems(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>('[data-breadcrumb-focusable="true"], button')
  ).filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
}

function scrollBreadcrumbIdIntoView(
  container: HTMLElement | null,
  panelId: string | null | undefined
) {
  if (!container || !panelId) return;
  const items = Array.from(container.querySelectorAll<HTMLElement>("[data-breadcrumb-id]"));
  const target = items.find((item) => item.dataset["breadcrumbId"] === panelId);
  target?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function updateBreadcrumbScrollState(
  element: HTMLElement | null,
  setScrollState: (state: { canScrollLeft: boolean; canScrollRight: boolean }) => void
) {
  if (!element) {
    setScrollState({ canScrollLeft: false, canScrollRight: false });
    return;
  }

  const maxScrollLeft = Math.max(0, element.scrollWidth - element.clientWidth);
  setScrollState({
    canScrollLeft: element.scrollLeft > 1,
    canScrollRight: element.scrollLeft < maxScrollLeft - 1,
  });
}

interface VisibleSiblingEntry {
  sibling: PanelSummary;
  originalIndex: number;
}

interface BreadcrumbSiblingPartition {
  visible: VisibleSiblingEntry[];
  hidden: PanelSummary[];
}

function partitionBreadcrumbSiblings(
  siblings: PanelSummary[],
  activeId: string | null,
  maxVisible: number = MAX_VISIBLE_SIBLINGS_PER_GROUP
): BreadcrumbSiblingPartition {
  if (siblings.length <= maxVisible) {
    return {
      visible: siblings.map((sibling, originalIndex) => ({ sibling, originalIndex })),
      hidden: [],
    };
  }

  const effectiveActiveId = activeId || siblings[0]?.id || null;
  const activeIndex = Math.max(
    0,
    siblings.findIndex((sibling) => sibling.id === effectiveActiveId)
  );
  const visibleIndexes = new Set<number>([0, siblings.length - 1, activeIndex]);
  const desiredVisible = Math.max(3, maxVisible - 1);

  for (let distance = 1; visibleIndexes.size < desiredVisible; distance++) {
    const before = activeIndex - distance;
    const after = activeIndex + distance;
    if (before > 0) visibleIndexes.add(before);
    if (visibleIndexes.size >= desiredVisible) break;
    if (after < siblings.length - 1) visibleIndexes.add(after);
    if (before <= 0 && after >= siblings.length - 1) break;
  }

  const visibleSet = visibleIndexes;
  return {
    visible: siblings
      .map((sibling, originalIndex) => ({ sibling, originalIndex }))
      .filter((entry) => visibleSet.has(entry.originalIndex)),
    hidden: siblings.filter((_sibling, index) => !visibleSet.has(index)),
  };
}

function BreadcrumbBar({
  title,
  navigationData,
  statusNavigation,
  onNavigateToId,
  onPanelAction,
  onEditAddress,
}: BreadcrumbBarProps) {
  const ancestors = navigationData?.ancestors ?? [];
  const currentSiblings = navigationData?.currentSiblings ?? [];
  const descendantGroups = statusNavigation?.descendantGroups ?? [];
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [maxVisibleSiblings, setMaxVisibleSiblings] = useState(MAX_VISIBLE_SIBLINGS_PER_GROUP);
  const [scrollState, setScrollState] = useState({ canScrollLeft: false, canScrollRight: false });

  const visibleAncestors = ancestors.slice(-MAX_VISIBLE_ANCESTORS);
  const hiddenAncestors = ancestors.slice(0, ancestors.length - visibleAncestors.length);

  const visibleDescendantGroups = descendantGroups.slice(0, MAX_VISIBLE_DESC_GROUPS);
  const hiddenDescendantGroups = descendantGroups.slice(visibleDescendantGroups.length);

  const refreshScrollState = useCallback(() => {
    updateBreadcrumbScrollState(scrollRef.current, setScrollState);
  }, []);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const handleResize = () => {
      setMaxVisibleSiblings(getVisibleSiblingLimit(element.clientWidth));
      refreshScrollState();
    };
    handleResize();

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }

    const observer = new ResizeObserver(handleResize);
    observer.observe(element);
    return () => observer.disconnect();
  }, [refreshScrollState]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      scrollBreadcrumbIdIntoView(scrollRef.current, navigationData?.currentId);
      refreshScrollState();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    currentSiblings.length,
    descendantGroups.length,
    maxVisibleSiblings,
    navigationData?.currentId,
    refreshScrollState,
  ]);

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

  const handleCurrentPanelContextMenu = async (e: MouseEvent<HTMLSpanElement>) => {
    e.preventDefault();
    const currentId = navigationData?.currentId;
    if (!currentId) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const action = await menu.showPanelContext(currentId, getWindowPositionFromRect(rect));
    if (action) {
      onPanelAction?.(currentId, action);
    }
  };

  const showSiblingMenu = async (e: MouseEvent<HTMLButtonElement>, siblings: PanelSummary[]) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const items = siblings.map((sibling) => ({
      id: sibling.id,
      label: sibling.title,
    }));
    const selected = await menu.showContext(items, getWindowPositionFromRect(rect));
    if (selected !== null) {
      onNavigateToId?.(selected);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const items = getFocusableBreadcrumbItems(e.currentTarget);
    if (items.length === 0) return;

    const activeElement = document.activeElement as HTMLElement | null;
    const currentIndex = activeElement ? items.indexOf(activeElement) : -1;
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const nextIndex =
      currentIndex === -1
        ? delta > 0
          ? 0
          : items.length - 1
        : Math.max(0, Math.min(items.length - 1, currentIndex + delta));

    e.preventDefault();
    const nextItem = items[nextIndex];
    nextItem?.focus();
    nextItem?.scrollIntoView({ block: "nearest", inline: "nearest" });
    window.requestAnimationFrame(refreshScrollState);
  };

  const renderBreadcrumbItem = (panel: PanelSummary, isActive: boolean, isCurrent: boolean) => (
    <HoverableBreadcrumbItem
      key={panel.id}
      panelId={panel.id}
      title={panel.title}
      isActive={isActive}
      isCurrent={isCurrent}
      onNavigate={() => onNavigateToId?.(panel.id)}
      onContextMenu={(e) => handlePanelContextMenu(e, panel)}
      onEditAddress={onEditAddress}
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
    const partition = partitionBreadcrumbSiblings(siblings, effectiveActiveId, maxVisibleSiblings);

    return (
      <span style={groupStyle}>
        {partition.visible.map(({ sibling, originalIndex }, visibleIndex) => {
          const previousEntry = partition.visible[visibleIndex - 1];
          const gapSiblings =
            partition.hidden.length > 0 &&
            visibleIndex > 0 &&
            previousEntry !== undefined &&
            originalIndex - previousEntry.originalIndex > 1
              ? siblings.slice(previousEntry.originalIndex + 1, originalIndex)
              : [];

          return (
            <span key={sibling.id} style={{ display: "inline-flex", alignItems: "center" }}>
              {visibleIndex > 0 && (
                <DividerVerticalIcon
                  style={{ color: "var(--gray-7)", width: 12, height: 12, flexShrink: 0 }}
                />
              )}
              {gapSiblings.length > 0 && (
                <>
                  <IconButton
                    size="1"
                    variant="ghost"
                    aria-label="More sibling panels"
                    onClick={(e) => showSiblingMenu(e, gapSiblings)}
                    style={{ appRegion: "no-drag", WebkitAppRegion: "no-drag" } as CSSProperties}
                  >
                    <DotsHorizontalIcon />
                  </IconButton>
                  <DividerVerticalIcon
                    style={{ color: "var(--gray-7)", width: 12, height: 12, flexShrink: 0 }}
                  />
                </>
              )}
              {renderBreadcrumbItem(sibling, sibling.id === effectiveActiveId, isCurrent)}
            </span>
          );
        })}
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
    const partition = partitionBreadcrumbSiblings(
      group.siblings,
      group.selectedId,
      maxVisibleSiblings
    );

    return (
      <span style={groupStyle}>
        {partition.visible.map(({ sibling, originalIndex }, visibleIndex) => {
          const previousEntry = partition.visible[visibleIndex - 1];
          const gapSiblings =
            partition.hidden.length > 0 &&
            visibleIndex > 0 &&
            previousEntry !== undefined &&
            originalIndex - previousEntry.originalIndex > 1
              ? group.siblings.slice(previousEntry.originalIndex + 1, originalIndex)
              : [];

          return (
            <span key={sibling.id} style={{ display: "inline-flex", alignItems: "center" }}>
              {visibleIndex > 0 && (
                <DividerVerticalIcon
                  style={{ color: "var(--gray-7)", width: 12, height: 12, flexShrink: 0 }}
                />
              )}
              {gapSiblings.length > 0 && (
                <>
                  <IconButton
                    size="1"
                    variant="ghost"
                    aria-label="More sibling panels"
                    onClick={(e) => showSiblingMenu(e, gapSiblings)}
                    style={{ appRegion: "no-drag", WebkitAppRegion: "no-drag" } as CSSProperties}
                  >
                    <DotsHorizontalIcon />
                  </IconButton>
                  <DividerVerticalIcon
                    style={{ color: "var(--gray-7)", width: 12, height: 12, flexShrink: 0 }}
                  />
                </>
              )}
              {renderBreadcrumbItem(sibling, sibling.id === group.selectedId, false)}
            </span>
          );
        })}
      </span>
    );
  };

  return (
    <Box
      style={
        {
          position: "relative",
          minWidth: 0,
          overflow: "hidden",
          appRegion: "drag",
          WebkitAppRegion: "drag",
        } as CSSProperties
      }
    >
      <Flex
        ref={scrollRef}
        align="center"
        gap="1"
        className="titlebar-breadcrumb-scroll"
        onScroll={refreshScrollState}
        onKeyDown={handleKeyDown}
        style={
          {
            appRegion: "drag",
            WebkitAppRegion: "drag",
            minWidth: 0,
            overflowX: "auto",
            overflowY: "hidden",
            overscrollBehaviorX: "contain",
            scrollbarWidth: "none",
            touchAction: "pan-x",
          } as CSSProperties
        }
      >
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
          <Flex key={ancestor.id} align="center" gap="1" style={{ flexShrink: 0 }}>
            <span style={groupStyle}>{renderAncestorItem(ancestor)}</span>
            <ChevronRightIcon color="var(--gray-8)" />
          </Flex>
        ))}

        {/* Current (with siblings) */}
        {currentSiblings.length > 0 ? (
          renderSiblingGroup(currentSiblings, navigationData?.currentId ?? null, true)
        ) : (
          <span style={groupStyle}>
            <HoverableBreadcrumbItem
              panelId={navigationData?.currentId ?? "current-panel"}
              title={navigationData?.currentTitle ?? title}
              isActive={true}
              isCurrent={true}
              onNavigate={() => {
                if (navigationData?.currentId) onNavigateToId?.(navigationData.currentId);
              }}
              onContextMenu={handleCurrentPanelContextMenu}
              onEditAddress={onEditAddress}
            />
          </span>
        )}

        {/* Descendants (sibling groups) */}
        {visibleDescendantGroups.map((group) => (
          <Flex key={`desc-${group.depth}`} align="center" gap="1" style={{ flexShrink: 0 }}>
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
      {scrollState.canScrollLeft && <Box className="titlebar-breadcrumb-fade left" />}
      {scrollState.canScrollRight && <Box className="titlebar-breadcrumb-fade right" />}
    </Box>
  );
}
