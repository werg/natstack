import { app, Menu, MenuItemConstructorOptions, type WebContents } from "electron";
import { eventService } from "./services/eventsService.js";

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
        eventService.emit("navigate-about", { page: "new" });
      },
    },
    { type: "separator" },
    {
      label: "Switch Workspace...",
      accelerator: "CmdOrCtrl+Shift+O",
      click: () => {
        eventService.emit("open-workspace-chooser");
      },
    },
    {
      label: "Model Provider Config...",
      accelerator: "CmdOrCtrl+Shift+M",
      click: () => {
        eventService.emit("navigate-about", { page: "model-provider-config" });
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
    { label: "Reload", accelerator: "CmdOrCtrl+R", role: "reload" },
    { label: "Force Reload", accelerator: "CmdOrCtrl+Shift+R", role: "forceReload" }
  );

  const dev: MenuItemConstructorOptions[] = [
    {
      label: "Toggle Panel DevTools",
      accelerator: "CmdOrCtrl+Shift+I",
      click: () => {
        eventService.emit("toggle-panel-devtools");
      },
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
        await options.includeClearCache!();
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
            eventService.emit("navigate-about", { page: "new" });
          },
        },
        { type: "separator" },
        {
          label: "Switch Workspace...",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => {
            eventService.emit("open-workspace-chooser");
          },
        },
        { type: "separator" },
        {
          label: "Model Provider Config...",
          accelerator: "CmdOrCtrl+Shift+M",
          click: () => {
            eventService.emit("navigate-about", { page: "model-provider-config" });
          },
        },
        { type: "separator" },
        isMac ? { role: "close" } : { role: "quit" },
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
        { role: "reload" },
        { role: "forceReload" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { type: "separator" },
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
          : [{ role: "close" }]),
      ] as MenuItemConstructorOptions[],
    },
    {
      role: "help",
      submenu: [
        {
          label: "Keyboard Shortcuts",
          accelerator: "CmdOrCtrl+/",
          click: () => {
            eventService.emit("navigate-about", { page: "keyboard-shortcuts" });
          },
        },
        { type: "separator" },
        {
          label: "Documentation",
          click: () => {
            eventService.emit("navigate-about", { page: "help" });
          },
        },
        {
          label: "About NatStack",
          click: () => {
            eventService.emit("navigate-about", { page: "about" });
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
