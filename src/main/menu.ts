import { app, Menu, shell, MenuItemConstructorOptions, type WebContents } from "electron";

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
