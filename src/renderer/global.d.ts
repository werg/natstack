declare namespace JSX {
  interface IntrinsicElements {
    webview: React.DetailedHTMLProps<
      React.HTMLAttributes<HTMLElement> & {
        src?: string;
        partition?: string;
        allowpopups?: string;
        preload?: string;
        nodeintegration?: string;
        plugins?: string;
        disablewebsecurity?: string;
        useragent?: string;
      },
      HTMLElement
    >;
  }
}

interface PanelBuildResult {
  success: boolean;
  bundlePath?: string;
  htmlPath?: string;
  error?: string;
}

interface Panel {
  id: string;
  title: string;
  path: string;
  children: Panel[];
  selectedChildId: string | null;
}

interface ElectronAPI {
  getAppInfo(): Promise<{ version: string }>;
  getSystemTheme(): Promise<"light" | "dark">;
  setThemeMode(mode: "light" | "dark" | "system"): Promise<void>;
  onSystemThemeChanged(callback: (theme: "light" | "dark") => void): () => void;
  buildPanel(path: string): Promise<PanelBuildResult>;
  getPanelTree(): Promise<Panel[]>;
  initRootPanel(path: string): Promise<Panel>;
  onPanelTreeUpdated(callback: (rootPanels: Panel[]) => void): () => void;
  getPanelPreloadPath(): Promise<string>;
  notifyPanelFocused(panelId: string): Promise<void>;
}

interface Window {
  electronAPI: ElectronAPI;
}
