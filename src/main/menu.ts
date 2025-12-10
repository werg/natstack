import { app, Menu, shell, MenuItemConstructorOptions, type WebContents } from "electron";

/**
 * Build common menu items that are shared between the app menu and hamburger popup.
 * These items need shell webcontents for IPC communication.
 */
export function buildCommonMenuItems(
  shellContents: WebContents,
  options?: { includeClearCache?: () => Promise<void> }
): {
  file: MenuItemConstructorOptions[];
  edit: MenuItemConstructorOptions[];
  view: MenuItemConstructorOptions[];
  dev: MenuItemConstructorOptions[];
} {
  const file: MenuItemConstructorOptions[] = [
    {
      label: "Switch Workspace...",
      accelerator: "CmdOrCtrl+Shift+O",
      click: () => {
        if (shellContents && !shellContents.isDestroyed()) {
          shellContents.send("open-workspace-chooser");
        }
      },
    },
    {
      label: "Settings...",
      accelerator: "CmdOrCtrl+,",
      click: () => {
        if (shellContents && !shellContents.isDestroyed()) {
          shellContents.send("open-settings");
        }
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

  const view: MenuItemConstructorOptions[] = [
    { label: "Reload", accelerator: "CmdOrCtrl+R", role: "reload" },
    { label: "Force Reload", accelerator: "CmdOrCtrl+Shift+R", role: "forceReload" },
  ];

  const dev: MenuItemConstructorOptions[] = [
    {
      label: "Toggle Panel DevTools",
      accelerator: "CmdOrCtrl+Shift+I",
      click: () => {
        if (shellContents && !shellContents.isDestroyed()) {
          shellContents.send("menu:toggle-panel-devtools");
        }
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
  clearBuildCache: () => Promise<void>
): MenuItemConstructorOptions[] {
  const common = buildCommonMenuItems(shellContents, { includeClearCache: clearBuildCache });

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
export function setupMenu(mainWindow: Electron.BaseWindow, shellContents: WebContents): void {
  const isMac = process.platform === "darwin";

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
          label: "Switch Workspace...",
          accelerator: "CmdOrCtrl+Shift+O",
          click: () => {
            if (shellContents && !shellContents.isDestroyed()) {
              shellContents.send("open-workspace-chooser");
            }
          },
        },
        { type: "separator" },
        {
          label: "Settings...",
          accelerator: "CmdOrCtrl+,",
          click: () => {
            if (shellContents && !shellContents.isDestroyed()) {
              shellContents.send("open-settings");
            }
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
          label: "Learn More",
          click: async () => {
            await shell.openExternal("https://electronjs.org");
          },
        },
      ],
    },
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
