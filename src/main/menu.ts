import { app, Menu, MenuItemConstructorOptions, type WebContents } from "electron";
import type { EventService } from "@natstack/shared/eventsService";
import type { ViewManager } from "./viewManager.js";
import type { BridgePanelManager } from "@natstack/shared/panelInterfaces";
import type { PanelRegistry } from "@natstack/shared/panelRegistry";
import { assertPresent } from "../lintHelpers";

// Set during initialization — always non-null after startup
let _menuPanelLifecycle: BridgePanelManager | null = null;
let _menuPanelRegistry: PanelRegistry | null = null;
let _menuViewManager: ViewManager | null = null;
let _menuEventService: EventService | null = null;
const panelDevToolsShortcutInterceptors = new WeakSet<WebContents>();

/** Set the event service for menu operations. Called from index.ts. */
export function setMenuEventService(es: EventService): void {
  _menuEventService = es;
}

/** Guard — throws if eventService not set yet */
function eventService(): EventService {
  if (!_menuEventService) throw new Error("Menu eventService not initialized");
  return _menuEventService;
}

/** Set the view manager for menu operations. Called from index.ts. */
export function setMenuViewManager(vm: ViewManager): void {
  _menuViewManager = vm;
}

/** Set the panel lifecycle for menu operations. Called from index.ts. */
export function setMenuPanelLifecycle(lc: BridgePanelManager): void {
  _menuPanelLifecycle = lc;
}

/** Set the panel registry for menu operations. Called from index.ts. */
export function setMenuPanelRegistry(reg: PanelRegistry): void {
  _menuPanelRegistry = reg;
}

/** Archive the currently focused panel (Cmd+W / Ctrl+W). Falls back to window close if no panel is focused. */
async function archiveFocusedPanel(mainWindow: Electron.BaseWindow): Promise<void> {
  const focusedId = _menuPanelRegistry?.getFocusedPanelId();
  if (focusedId && _menuPanelLifecycle) {
    await _menuPanelLifecycle.closePanel(focusedId);
  } else {
    mainWindow.close();
  }
}

function reloadFocusedPanel(force = false): void {
  const focusedId = _menuPanelRegistry?.getFocusedPanelId();
  if (!focusedId || !_menuViewManager) return;
  if (force) _menuViewManager.forceReload(focusedId);
  else _menuViewManager.reload(focusedId);
}

function dispatchChromeCommand(command: "reload-panel" | "force-reload-view" | "stop"): void {
  try {
    eventService().emit("panel-chrome-command", { command });
  } catch {
    if (command === "reload-panel") reloadFocusedPanel(false);
    if (command === "force-reload-view") reloadFocusedPanel(true);
    if (command === "stop") stopFocusedPanel();
  }
}

function stopFocusedPanel(): void {
  const focusedId = _menuPanelRegistry?.getFocusedPanelId();
  if (!focusedId || !_menuViewManager) return;
  _menuViewManager.stop(focusedId);
}

function openFocusedPanelDevTools(): boolean {
  const focusedId = _menuPanelRegistry?.getFocusedPanelId();
  if (!focusedId || !_menuViewManager?.hasView(focusedId)) {
    return false;
  }
  _menuViewManager.openDevTools(focusedId);
  return true;
}

function togglePanelDevTools(): void {
  if (!openFocusedPanelDevTools()) {
    eventService().emit("toggle-panel-devtools");
  }
}

function isPanelDevToolsInput(input: Electron.Input): boolean {
  if (input.type !== "keyDown") {
    return false;
  }
  if (input.key.toLowerCase() !== "i" && input.code !== "KeyI") {
    return false;
  }
  const hasPrimary = process.platform === "darwin" ? input.meta : input.control;
  return hasPrimary && input.shift && !input.alt;
}

function interceptPanelDevToolsShortcut(shellContents: WebContents): void {
  if (panelDevToolsShortcutInterceptors.has(shellContents)) {
    return;
  }
  panelDevToolsShortcutInterceptors.add(shellContents);

  shellContents.on("before-input-event", (event, input) => {
    if (!isPanelDevToolsInput(input)) {
      return;
    }
    event.preventDefault();
    togglePanelDevTools();
  });
}

/**
 * Build common menu items that are shared between the app menu and hamburger popup.
 * These items need shell webcontents for IPC communication.
 */
export function buildCommonMenuItems(
  shellContents: WebContents,
  options?: {
    includeClearCache?: () => Promise<void>;
    onHistoryBack?: () => void;
    onHistoryForward?: () => void;
  }
): {
  file: MenuItemConstructorOptions[];
  edit: MenuItemConstructorOptions[];
  view: MenuItemConstructorOptions[];
  dev: MenuItemConstructorOptions[];
} {
  const isMac = process.platform === "darwin";
  const backAccelerator = isMac ? "Cmd+[" : "Alt+Left";
  const forwardAccelerator = isMac ? "Cmd+]" : "Alt+Right";
  const file: MenuItemConstructorOptions[] = [
    {
      label: "New Panel",
      accelerator: "CmdOrCtrl+T",
      click: () => {
        eventService().emit("navigate-about", { page: "new" });
      },
    },
    { type: "separator" },
    {
      label: "Switch Workspace...",
      accelerator: "CmdOrCtrl+Shift+O",
      click: () => {
        eventService().emit("open-workspace-switcher");
      },
    },
  ];

  const edit: MenuItemConstructorOptions[] = [
    { label: "Undo", accelerator: "CmdOrCtrl+Z", role: "undo" },
    { label: "Redo", accelerator: "CmdOrCtrl+Y", role: "redo" },
    { type: "separator" },
    { label: "Cut", accelerator: "CmdOrCtrl+X", role: "cut" },
    { label: "Copy", accelerator: "CmdOrCtrl+C", role: "copy" },
    { label: "Paste", accelerator: "CmdOrCtrl+V", role: "paste" },
  ];

  const view: MenuItemConstructorOptions[] = [];
  if (options?.onHistoryBack) {
    view.push({
      label: "Back",
      accelerator: backAccelerator,
      click: () => options.onHistoryBack?.(),
    });
  }
  if (options?.onHistoryForward) {
    view.push({
      label: "Forward",
      accelerator: forwardAccelerator,
      click: () => options.onHistoryForward?.(),
    });
  }
  if (view.length > 0) {
    view.push({ type: "separator" });
  }
  view.push(
    {
      label: "Reload Panel",
      accelerator: "CmdOrCtrl+R",
      click: () => dispatchChromeCommand("reload-panel"),
    },
    {
      label: "Force Reload View",
      accelerator: "CmdOrCtrl+Shift+R",
      click: () => dispatchChromeCommand("force-reload-view"),
    },
    { label: "Stop Loading", accelerator: "Esc", click: () => dispatchChromeCommand("stop") },
    {
      label: "Toggle Address Bar",
      accelerator: "CmdOrCtrl+L",
      click: () => {
        eventService().emit("toggle-address-bar");
        eventService().emit("focus-address-bar");
      },
    },
    { type: "separator" },
    {
      label: "Refresh Panel Display",
      click: () => {
        if (_menuViewManager) {
          const vm = assertPresent(_menuViewManager);
          vm.refreshVisiblePanel();
          vm.forceRepaintVisiblePanel();
        }
      },
    }
  );

  const dev: MenuItemConstructorOptions[] = [
    {
      label: "Toggle Panel DevTools",
      accelerator: "CmdOrCtrl+Shift+I",
      click: () => togglePanelDevTools(),
    },
    {
      label: "Toggle App DevTools",
      accelerator: "CmdOrCtrl+Alt+I",
      click: () => {
        if (shellContents && !shellContents.isDestroyed()) {
          shellContents.toggleDevTools();
        }
      },
    },
  ];

  if (options?.includeClearCache) {
    dev.push({ type: "separator" });
    dev.push({
      label: "Clear Build Cache",
      click: async () => {
        await assertPresent(options.includeClearCache)();
      },
    });
  }

  return { file, edit, view, dev };
}

/**
 * Build the hamburger popup menu template.
 * Uses shared menu items but structured for popup display.
 */
export function buildHamburgerMenuTemplate(
  shellContents: WebContents,
  clearBuildCache: () => Promise<void>,
  options?: {
    onHistoryBack?: () => void;
    onHistoryForward?: () => void;
  }
): MenuItemConstructorOptions[] {
  const common = buildCommonMenuItems(shellContents, {
    includeClearCache: clearBuildCache,
    onHistoryBack: options?.onHistoryBack,
    onHistoryForward: options?.onHistoryForward,
  });

  return [
    ...common.file,
    { type: "separator" },
    ...common.edit,
    { type: "separator" },
    ...common.view,
    ...common.dev,
    { type: "separator" },
    { label: "Exit", accelerator: "CmdOrCtrl+Q", role: "quit" },
  ];
}

/**
 * Setup application menu.
 * @param mainWindow - The main BaseWindow (for window operations)
 * @param shellContents - WebContents for the shell view (for IPC and devtools)
 */
export function setupMenu(
  mainWindow: Electron.BaseWindow,
  shellContents: WebContents,
  options?: { onHistoryBack?: () => void; onHistoryForward?: () => void }
): void {
  interceptPanelDevToolsShortcut(shellContents);

  const isMac = process.platform === "darwin";
  const backAccelerator = isMac ? "Cmd+[" : "Alt+Left";
  const forwardAccelerator = isMac ? "Cmd+]" : "Alt+Right";
  const viewSubmenu: MenuItemConstructorOptions[] = [];

  if (options?.onHistoryBack) {
    viewSubmenu.push({
      label: "Back",
      accelerator: backAccelerator,
      click: () => options.onHistoryBack?.(),
    });
  }
  if (options?.onHistoryForward) {
    viewSubmenu.push({
      label: "Forward",
      accelerator: forwardAccelerator,
      click: () => options.onHistoryForward?.(),
    });
  }
  if (viewSubmenu.length > 0) {
    viewSubmenu.push({ type: "separator" });
  }

  const template: MenuItemConstructorOptions[] = [
    // { role: 'appMenu' }
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: "about" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit" },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    // { role: 'fileMenu' }
    {
      label: "File",
      submenu: [
        {
          label: "New Panel",
          accelerator: "CmdOrCtrl+T",
          click: () => {
            eventService().emit("navigate-about", { page: "new" });
          },
        },
        { type: "separator" },
        {
          label: "Switch Workspace...",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => {
            eventService().emit("open-workspace-switcher");
          },
        },
        { type: "separator" },
        isMac
          ? {
              label: "Archive Panel",
              accelerator: "CmdOrCtrl+W",
              click: () => archiveFocusedPanel(mainWindow),
            }
          : { role: "quit" },
      ] as MenuItemConstructorOptions[],
    },
    // { role: 'editMenu' }
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        ...(isMac
          ? [
              { role: "pasteAndMatchStyle" },
              { role: "delete" },
              { role: "selectAll" },
              { type: "separator" },
              {
                label: "Speech",
                submenu: [{ role: "startSpeaking" }, { role: "stopSpeaking" }],
              },
            ]
          : [{ role: "delete" }, { type: "separator" }, { role: "selectAll" }]),
      ] as MenuItemConstructorOptions[],
    },
    // { role: 'viewMenu' }
    {
      label: "View",
      submenu: [
        ...viewSubmenu,
        {
          label: "Reload Panel",
          accelerator: "CmdOrCtrl+R",
          click: () => dispatchChromeCommand("reload-panel"),
        },
        {
          label: "Force Reload View",
          accelerator: "CmdOrCtrl+Shift+R",
          click: () => dispatchChromeCommand("force-reload-view"),
        },
        { label: "Stop Loading", accelerator: "Esc", click: () => dispatchChromeCommand("stop") },
        { type: "separator" },
        {
          label: "Toggle Address Bar",
          accelerator: "CmdOrCtrl+L",
          click: () => {
            eventService().emit("toggle-address-bar");
            eventService().emit("focus-address-bar");
          },
        },
        { type: "separator" },
        {
          label: "Refresh Panel Display",
          click: () => {
            if (_menuViewManager) {
              const vm = assertPresent(_menuViewManager);
              vm.refreshVisiblePanel();
              vm.forceRepaintVisiblePanel();
            }
          },
        },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
        {
          label: "Toggle Panel Developer Tools",
          accelerator: "CmdOrCtrl+Shift+I",
          click: () => togglePanelDevTools(),
        },
        {
          label: "Toggle App Developer Tools",
          accelerator: "CmdOrCtrl+Alt+I",
          click: () => {
            if (shellContents && !shellContents.isDestroyed()) {
              shellContents.toggleDevTools();
            }
          },
        },
      ],
    },
    // { role: 'windowMenu' }
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac
          ? [{ type: "separator" }, { role: "front" }, { type: "separator" }, { role: "window" }]
          : [
              {
                label: "Archive Panel",
                accelerator: "Ctrl+W",
                click: () => archiveFocusedPanel(mainWindow),
              },
            ]),
      ] as MenuItemConstructorOptions[],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Keyboard Shortcuts",
          accelerator: "CmdOrCtrl+/",
          click: () => {
            eventService().emit("navigate-about", { page: "keyboard-shortcuts" });
          },
        },
        { type: "separator" },
        {
          label: "Documentation",
          click: () => {
            eventService().emit("navigate-about", { page: "help" });
          },
        },
        {
          label: "About NatStack",
          click: () => {
            eventService().emit("navigate-about", { page: "about" });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
