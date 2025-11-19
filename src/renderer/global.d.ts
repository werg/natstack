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

type Panel = import("main/panelTypes").Panel;

type ElectronAPI = typeof import("../preload/index").electronAPI;

interface Window {
  electronAPI: ElectronAPI;
}
