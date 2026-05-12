import type { AddressAction, PanelChromeState } from "./panelChrome.js";

export type AddressNavigationMode = "current" | "child" | "root" | "external";

export const BROWSER_NAVIGATION_TRANSITIONS = [
  "link",
  "typed",
  "generated",
  "keyword_generated",
  "reload",
  "back_forward",
] as const;

export type BrowserNavigationTransition = (typeof BROWSER_NAVIGATION_TRANSITIONS)[number];

export interface BrowserNavigationIntent {
  transition?: BrowserNavigationTransition;
  typed?: boolean;
}

export interface AddressNavigationModifiers {
  shiftKey?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
}

export type PanelCommandId =
  | "back"
  | "forward"
  | "reload-panel"
  | "reload-view"
  | "force-reload-view"
  | "rebuild-panel"
  | "stop"
  | "focus-address"
  | "copy-address"
  | "open-external"
  | "duplicate"
  | "unload"
  | "archive";

export interface PanelCommandContext {
  chrome?: PanelChromeState | null;
  addressBarVisible?: boolean;
}

export interface PanelCommandDefinition {
  id: PanelCommandId;
  label: string;
  shortcut?: string;
  visible: boolean;
  enabled: boolean;
}

export const DEFAULT_SEARCH_TEMPLATE = "https://www.google.com/search?q=%s";

export function applySearchTemplate(query: string, template: string = DEFAULT_SEARCH_TEMPLATE): string {
  const encoded = encodeURIComponent(query);
  if (template.includes("%s")) return template.replace(/%s/g, encoded);
  const separator = template.includes("?") ? "&" : "?";
  return `${template}${separator}q=${encoded}`;
}

export function canonicalizeBrowserHistoryUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = "";
    if ((parsed.protocol === "http:" && parsed.port === "80") || (parsed.protocol === "https:" && parsed.port === "443")) {
      parsed.port = "";
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

export function getBrowserNavigationIntentForCommand(command: PanelCommandId): BrowserNavigationIntent | null {
  if (command === "back" || command === "forward") return { transition: "back_forward", typed: false };
  if (command === "reload-panel" || command === "reload-view" || command === "force-reload-view") {
    return { transition: "reload", typed: false };
  }
  return null;
}

export function getBrowserNavigationIntentForAddressAction(action: AddressAction): BrowserNavigationIntent | null {
  if (action.type === "navigate-url" && action.recordAsTyped) return { transition: "typed", typed: true };
  if (action.type === "search") return { transition: "generated", typed: Boolean(action.recordAsTyped) };
  if (action.type === "keyword-search") return { transition: "keyword_generated", typed: Boolean(action.recordAsTyped) };
  return null;
}

export function getAddressNavigationModeFromModifiers(
  modifiers: AddressNavigationModifiers,
): AddressNavigationMode {
  if (modifiers.altKey) return "external";
  if (modifiers.metaKey || modifiers.ctrlKey) return "root";
  if (modifiers.shiftKey) return "child";
  return "current";
}

export function getPanelCommandDefinitions(
  context: PanelCommandContext = {},
): PanelCommandDefinition[] {
  const chrome = context.chrome ?? null;
  const isBrowser = chrome?.kind === "browser";
  const isPanel = chrome?.kind === "panel";
  const hasAddress = Boolean(chrome?.editableAddress || chrome?.resolvedUrl);

  return [
    {
      id: "back",
      label: "Back",
      shortcut: "Alt+Left",
      visible: true,
      enabled: Boolean(chrome?.canGoBack),
    },
    {
      id: "forward",
      label: "Forward",
      shortcut: "Alt+Right",
      visible: true,
      enabled: Boolean(chrome?.canGoForward),
    },
    {
      id: "reload-panel",
      label: "Reload Panel",
      shortcut: "Cmd/Ctrl+R",
      visible: true,
      enabled: Boolean(chrome),
    },
    {
      id: "reload-view",
      label: "Reload View",
      visible: true,
      enabled: Boolean(chrome),
    },
    {
      id: "force-reload-view",
      label: "Force Reload View",
      shortcut: "Cmd/Ctrl+Shift+R",
      visible: true,
      enabled: Boolean(chrome),
    },
    {
      id: "rebuild-panel",
      label: "Rebuild Panel",
      visible: isPanel,
      enabled: isPanel,
    },
    {
      id: "stop",
      label: "Stop Loading",
      shortcut: "Esc",
      visible: true,
      enabled: Boolean(chrome?.isLoading),
    },
    {
      id: "focus-address",
      label: context.addressBarVisible ? "Focus Address" : "Show Address Bar",
      shortcut: "Cmd/Ctrl+L",
      visible: true,
      enabled: true,
    },
    {
      id: "copy-address",
      label: "Copy Address",
      visible: true,
      enabled: hasAddress,
    },
    {
      id: "open-external",
      label: "Open in System Browser",
      visible: isBrowser,
      enabled: Boolean(chrome?.resolvedUrl && /^https?:\/\//i.test(chrome.resolvedUrl)),
    },
    {
      id: "duplicate",
      label: "Duplicate",
      visible: true,
      enabled: Boolean(chrome),
    },
    {
      id: "unload",
      label: "Unload",
      visible: true,
      enabled: Boolean(chrome),
    },
    {
      id: "archive",
      label: "Archive",
      visible: true,
      enabled: Boolean(chrome),
    },
  ];
}

export function getAvailablePanelCommands(
  context: PanelCommandContext = {},
  ids?: readonly PanelCommandId[],
): PanelCommandDefinition[] {
  const allowed = ids ? new Set<PanelCommandId>(ids) : null;
  return getPanelCommandDefinitions(context).filter((command) => {
    if (!command.visible || !command.enabled) return false;
    return !allowed || allowed.has(command.id);
  });
}
