import type { RpcBridge } from "@natstack/rpc";

export interface CdpEndpoint {
  wsEndpoint: string;
  token?: string;
}

export interface BrowserAutomation {
  page(): Promise<any>;
  getCdpEndpoint(): Promise<CdpEndpoint>;
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  stop(): Promise<void>;
  click(selector: string): Promise<void>;
  screenshot(options?: unknown): Promise<unknown>;
}

export function createBrowserAutomation(
  rpc: RpcBridge,
  shell: any,
  id: string,
  kind: "workspace" | "browser"
): BrowserAutomation {
  const assertBrowser = () => {
    if (kind !== "browser") {
      throw new Error(`Panel ${id} is a workspace panel; browser automation is only available for browser panels`);
    }
  };

  const getCdpEndpoint = async (): Promise<CdpEndpoint> => {
    assertBrowser();
    if (shell?.getCdpEndpoint) return shell.getCdpEndpoint(id);
    return rpc.call<CdpEndpoint>("main", "browser.getCdpEndpoint", [id]);
  };

  const page = async (): Promise<any> => {
    assertBrowser();
    const require = (globalThis as Record<string, unknown>)["__natstackRequire__"] as
      | ((id: string) => { BrowserImpl: { connect(ws: string, opts: object): Promise<any> } })
      | undefined;
    if (!require) {
      throw new Error("handle.browser.page() requires __natstackRequire__ (panel runtime)");
    }
    const { BrowserImpl } = require("@workspace/playwright-client");
    const endpoint = await getCdpEndpoint();
    const options: { isElectronWebview: boolean; transportOptions?: { authToken: string } } = {
      isElectronWebview: true,
    };
    if (endpoint.token) options.transportOptions = { authToken: endpoint.token };
    const browser = await BrowserImpl.connect(endpoint.wsEndpoint, options);
    const resolvedPage = browser.contexts()[0]?.pages()[0];
    if (!resolvedPage) throw new Error("No page found in browser panel");
    return resolvedPage;
  };

  return {
    page,
    getCdpEndpoint,
    navigate: (url) => {
      assertBrowser();
      if (shell?.navigate) return shell.navigate(id, url);
      return rpc.call<void>("main", "browser.navigate", [id, url]);
    },
    goBack: () => {
      assertBrowser();
      if (shell?.goBack) return shell.goBack(id);
      return rpc.call<void>("main", "browser.goBack", [id]);
    },
    goForward: () => {
      assertBrowser();
      if (shell?.goForward) return shell.goForward(id);
      return rpc.call<void>("main", "browser.goForward", [id]);
    },
    reload: () => {
      assertBrowser();
      if (shell?.reload) return shell.reload(id);
      return rpc.call<void>("main", "browser.reload", [id]);
    },
    stop: () => {
      assertBrowser();
      if (shell?.stop) return shell.stop(id);
      return rpc.call<void>("main", "browser.stop", [id]);
    },
    click: async (selector) => {
      const p = await page();
      await p.click(selector);
    },
    screenshot: async (options) => {
      const p = await page();
      return p.screenshot(options);
    },
  };
}
