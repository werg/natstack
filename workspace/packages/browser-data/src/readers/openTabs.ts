import * as fs from "fs";
import * as path from "path";
import type { BrowserName, BrowserOpenTabsRequest, ImportedOpenTab } from "../types.js";
import { decompressMozLz4 } from "./firefoxReader.js";

interface FirefoxSessionFile {
  path: string;
  mtimeMs: number;
}

interface FirefoxSession {
  windows?: Array<{
    selected?: number;
    tabs?: Array<{
      index?: number;
      entries?: Array<{ url?: string; title?: string }>;
      pinned?: boolean;
      lastAccessed?: number;
    }>;
  }>;
}

interface ChromiumNavigation {
  index: number;
  url: string;
  title?: string;
}

interface ChromiumTabState {
  tabId: number;
  windowId?: number;
  visualIndex?: number;
  currentNavigationIndex?: number;
  pinned?: boolean;
  navigations: Map<number, ChromiumNavigation>;
}

const CHROMIUM_COMMAND_SET_TAB_WINDOW = 0;
const CHROMIUM_COMMAND_SET_TAB_INDEX_IN_WINDOW = 2;
const CHROMIUM_COMMAND_UPDATE_TAB_NAVIGATION = 6;
const CHROMIUM_COMMAND_SET_SELECTED_NAVIGATION_INDEX = 7;
const CHROMIUM_COMMAND_SET_SELECTED_TAB_IN_WINDOW = 8;
const CHROMIUM_COMMAND_SET_PINNED_STATE = 12;
const CHROMIUM_COMMAND_TAB_CLOSED = 16;
const CHROMIUM_COMMAND_WINDOW_CLOSED = 17;
const CHROMIUM_COMMAND_INITIAL_STATE_MARKER = 255;

const CHROMIUM_SESSION_SIGNATURE = 0x53534e53;
const CHROMIUM_CLEAR_SESSION_VERSION = 3;

export function readOpenTabs(request: BrowserOpenTabsRequest): ImportedOpenTab[] {
  const profilePath = resolveOpenTabsProfilePath(request);
  if (request.browser === "firefox" || request.browser === "zen") {
    return readFirefoxOpenTabs(request.browser, profilePath);
  }
  if (request.browser === "safari") {
    return [];
  }
  return readChromiumOpenTabs(request.browser, profilePath);
}

function resolveOpenTabsProfilePath(request: BrowserOpenTabsRequest): string {
  if (typeof request.profile === "string") return request.profile;
  if (request.profile?.path) return request.profile.path;
  throw new Error("'profile' must be provided");
}

function readFirefoxOpenTabs(browser: BrowserName, profilePath: string): ImportedOpenTab[] {
  const file = newestExistingFirefoxSessionFile(profilePath);
  if (!file) return [];

  const data = readFirefoxSessionJson(file.path);
  if (!data?.windows) return [];

  const tabs: ImportedOpenTab[] = [];
  data.windows.forEach((window, windowIndex) => {
    const selectedTabIndex = typeof window.selected === "number" ? window.selected - 1 : -1;
    window.tabs?.forEach((tab, tabIndex) => {
      const entryIndex =
        typeof tab.index === "number" && tab.index > 0 ? tab.index - 1 : (tab.entries?.length ?? 1) - 1;
      const entry = tab.entries?.[Math.max(0, entryIndex)] ?? tab.entries?.at(-1);
      const url = normalizeSessionUrl(entry?.url);
      if (!url) return;
      tabs.push({
        url,
        ...(entry?.title ? { title: entry.title } : {}),
        browser,
        profilePath,
        windowIndex,
        tabIndex,
        active: tabIndex === selectedTabIndex,
        ...(tab.pinned !== undefined ? { pinned: Boolean(tab.pinned) } : {}),
        ...(typeof tab.lastAccessed === "number" ? { lastAccessed: tab.lastAccessed } : {}),
      });
    });
  });

  return tabs;
}

function newestExistingFirefoxSessionFile(profilePath: string): FirefoxSessionFile | null {
  const candidates: string[] = [
    path.join(profilePath, "sessionstore-backups", "recovery.jsonlz4"),
    path.join(profilePath, "sessionstore-backups", "recovery.baklz4"),
    path.join(profilePath, "sessionstore.jsonlz4"),
    path.join(profilePath, "sessionstore-backups", "previous.jsonlz4"),
  ];

  const backupsDir = path.join(profilePath, "sessionstore-backups");
  try {
    for (const entry of fs.readdirSync(backupsDir)) {
      if (/^upgrade.*\.jsonlz4$/i.test(entry)) {
        candidates.push(path.join(backupsDir, entry));
      }
    }
  } catch {
    // No backup directory or not readable.
  }

  return candidates
    .flatMap((candidate) => {
      try {
        const stat = fs.statSync(candidate);
        return stat.isFile() ? [{ path: candidate, mtimeMs: stat.mtimeMs }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs)[0] ?? null;
}

function readFirefoxSessionJson(filePath: string): FirefoxSession | null {
  try {
    const raw = fs.readFileSync(filePath);
    const json = filePath.endsWith(".jsonlz4") || filePath.endsWith(".baklz4")
      ? decompressMozLz4(raw).toString("utf-8")
      : raw.toString("utf-8");
    return JSON.parse(json) as FirefoxSession;
  } catch {
    return null;
  }
}

function readChromiumOpenTabs(browser: BrowserName, profilePath: string): ImportedOpenTab[] {
  for (const filePath of chromiumSessionCandidates(profilePath)) {
    const tabs = readChromiumSessionFile(browser, profilePath, filePath);
    if (tabs.length > 0) return tabs;
  }
  return [];
}

function chromiumSessionCandidates(profilePath: string): string[] {
  const candidates: Array<{ path: string; mtimeMs: number }> = [];
  const addFile = (filePath: string) => {
    try {
      const stat = fs.statSync(filePath);
      if (stat.isFile()) candidates.push({ path: filePath, mtimeMs: stat.mtimeMs });
    } catch {
      // Missing or unreadable.
    }
  };
  const addMatching = (dir: string, pattern: RegExp) => {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (pattern.test(entry)) addFile(path.join(dir, entry));
      }
    } catch {
      // Missing or unreadable.
    }
  };

  addMatching(path.join(profilePath, "Sessions"), /^Session_/);
  addMatching(path.join(profilePath, "Sessions_Encrypted"), /^Session_/);
  addFile(path.join(profilePath, "Current Session"));
  addFile(path.join(profilePath, "Last Session"));

  return candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).map((candidate) => candidate.path);
}

function readChromiumSessionFile(
  browser: BrowserName,
  profilePath: string,
  filePath: string,
): ImportedOpenTab[] {
  let data: Buffer;
  try {
    data = fs.readFileSync(filePath);
  } catch {
    return [];
  }
  if (data.length < 8 || data.readInt32LE(0) !== CHROMIUM_SESSION_SIGNATURE) {
    return [];
  }
  const version = data.readInt32LE(4);
  if (version !== CHROMIUM_CLEAR_SESSION_VERSION) {
    return [];
  }

  const tabs = new Map<number, ChromiumTabState>();
  const closedWindows = new Set<number>();
  const selectedTabVisualIndexByWindow = new Map<number, number>();
  const windowOrder: number[] = [];
  let offset = 8;

  const getTab = (tabId: number): ChromiumTabState => {
    let tab = tabs.get(tabId);
    if (!tab) {
      tab = { tabId, navigations: new Map() };
      tabs.set(tabId, tab);
    }
    return tab;
  };
  const rememberWindow = (windowId: number) => {
    if (!windowOrder.includes(windowId)) windowOrder.push(windowId);
  };

  while (offset + 2 <= data.length) {
    const commandSize = data.readUInt16LE(offset);
    offset += 2;
    if (commandSize < 1 || offset + commandSize > data.length) break;

    const commandId = data[offset]!;
    const contents = data.subarray(offset + 1, offset + commandSize);
    offset += commandSize;

    switch (commandId) {
      case CHROMIUM_COMMAND_INITIAL_STATE_MARKER:
        break;
      case CHROMIUM_COMMAND_SET_TAB_WINDOW: {
        if (contents.length < 8) break;
        const windowId = contents.readInt32LE(0);
        const tabId = contents.readInt32LE(4);
        const tab = getTab(tabId);
        tab.windowId = windowId;
        rememberWindow(windowId);
        break;
      }
      case CHROMIUM_COMMAND_SET_TAB_INDEX_IN_WINDOW: {
        if (contents.length < 8) break;
        getTab(contents.readInt32LE(0)).visualIndex = contents.readInt32LE(4);
        break;
      }
      case CHROMIUM_COMMAND_UPDATE_TAB_NAVIGATION: {
        const parsed = readChromiumNavigationCommand(contents);
        if (!parsed) break;
        getTab(parsed.tabId).navigations.set(parsed.navigation.index, parsed.navigation);
        break;
      }
      case CHROMIUM_COMMAND_SET_SELECTED_NAVIGATION_INDEX: {
        if (contents.length < 8) break;
        getTab(contents.readInt32LE(0)).currentNavigationIndex = contents.readInt32LE(4);
        break;
      }
      case CHROMIUM_COMMAND_SET_SELECTED_TAB_IN_WINDOW: {
        if (contents.length < 8) break;
        const windowId = contents.readInt32LE(0);
        selectedTabVisualIndexByWindow.set(windowId, contents.readInt32LE(4));
        rememberWindow(windowId);
        break;
      }
      case CHROMIUM_COMMAND_SET_PINNED_STATE: {
        if (contents.length < 5) break;
        getTab(contents.readInt32LE(0)).pinned = contents[4] !== 0;
        break;
      }
      case CHROMIUM_COMMAND_TAB_CLOSED:
        if (contents.length >= 4) tabs.delete(contents.readInt32LE(0));
        break;
      case CHROMIUM_COMMAND_WINDOW_CLOSED:
        if (contents.length >= 4) closedWindows.add(contents.readInt32LE(0));
        break;
      default:
        break;
    }
  }

  const windowIndexById = new Map(
    windowOrder.filter((id) => !closedWindows.has(id)).map((id, index) => [id, index]),
  );
  const grouped = new Map<number, ChromiumTabState[]>();
  for (const tab of tabs.values()) {
    if (tab.windowId == null || closedWindows.has(tab.windowId) || tab.navigations.size === 0) {
      continue;
    }
    const list = grouped.get(tab.windowId) ?? [];
    list.push(tab);
    grouped.set(tab.windowId, list);
    if (!windowIndexById.has(tab.windowId)) {
      windowIndexById.set(tab.windowId, windowIndexById.size);
    }
  }

  const result: ImportedOpenTab[] = [];
  for (const [windowId, windowTabs] of grouped) {
    const sortedTabs = windowTabs.sort(
      (a, b) => (a.visualIndex ?? Number.MAX_SAFE_INTEGER) - (b.visualIndex ?? Number.MAX_SAFE_INTEGER),
    );
    const selectedVisualIndex = selectedTabVisualIndexByWindow.get(windowId);
    sortedTabs.forEach((tab, tabIndex) => {
      const navigation = currentChromiumNavigation(tab);
      const url = normalizeSessionUrl(navigation?.url);
      if (!url) return;
      const active =
        selectedVisualIndex != null &&
        (selectedVisualIndex === tab.visualIndex || selectedVisualIndex === tabIndex);
      result.push({
        url,
        ...(navigation?.title ? { title: navigation.title } : {}),
        browser,
        profilePath,
        windowIndex: windowIndexById.get(windowId) ?? 0,
        tabIndex,
        active,
        ...(tab.pinned !== undefined ? { pinned: tab.pinned } : {}),
      });
    });
  }

  return result.sort((a, b) => a.windowIndex - b.windowIndex || a.tabIndex - b.tabIndex);
}

function readChromiumNavigationCommand(
  contents: Buffer,
): { tabId: number; navigation: ChromiumNavigation } | null {
  const reader = PickleReader.from(contents);
  if (!reader) return null;
  const tabId = reader.readInt();
  const index = reader.readInt();
  const url = reader.readString();
  const title = reader.readString16();
  if (tabId == null || index == null || !url) return null;
  return {
    tabId,
    navigation: {
      index,
      url,
      ...(title ? { title } : {}),
    },
  };
}

function currentChromiumNavigation(tab: ChromiumTabState): ChromiumNavigation | null {
  const navigations = [...tab.navigations.values()].sort((a, b) => a.index - b.index);
  if (navigations.length === 0) return null;
  if (tab.currentNavigationIndex != null) {
    const exact = navigations.find((navigation) => navigation.index === tab.currentNavigationIndex);
    if (exact) return exact;
    const bounded = navigations[Math.max(0, Math.min(tab.currentNavigationIndex, navigations.length - 1))];
    if (bounded) return bounded;
  }
  return navigations[navigations.length - 1] ?? null;
}

function normalizeSessionUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).toString();
  } catch {
    return null;
  }
}

class PickleReader {
  private constructor(
    private readonly data: Buffer,
    private offset: number,
    private readonly end: number,
  ) {}

  static from(data: Buffer): PickleReader | null {
    if (data.length < 4) return null;
    const payloadSize = data.readUInt32LE(0);
    const headerSize = data.length - payloadSize;
    if (headerSize < 4 || headerSize % 4 !== 0 || payloadSize > data.length - 4) {
      return null;
    }
    return new PickleReader(data, headerSize, data.length);
  }

  readInt(): number | null {
    if (this.offset + 4 > this.end) return null;
    const value = this.data.readInt32LE(this.offset);
    this.offset += 4;
    return value;
  }

  readString(): string | null {
    const length = this.readInt();
    if (length == null || length < 0 || this.offset + length > this.end) return null;
    const value = this.data.toString("utf-8", this.offset, this.offset + length);
    this.offset += length;
    this.alignAfter(length);
    return value;
  }

  readString16(): string | null {
    const length = this.readInt();
    if (length == null || length < 0) return null;
    const byteLength = length * 2;
    if (this.offset + byteLength > this.end) return null;
    const value = this.data.toString("utf16le", this.offset, this.offset + byteLength);
    this.offset += byteLength;
    this.alignAfter(byteLength);
    return value;
  }

  private alignAfter(bytesRead: number): void {
    const padding = (4 - (bytesRead % 4)) % 4;
    this.offset = Math.min(this.offset + padding, this.end);
  }
}
