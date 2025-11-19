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

interface Panel {
  id: string;
  title: string;
  path: string;
  children: Panel[];
  selectedChildId: string | null;
  injectHostThemeVariables: boolean;
  artifacts: {
    htmlPath?: string;
    bundlePath?: string;
    error?: string;
  };
}

type ElectronAPI = typeof import("../preload/index").electronAPI;

interface Window {
  electronAPI: ElectronAPI;
}
