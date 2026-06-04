import { BrowserImpl } from "@workspace/playwright-core";

export interface CdpEndpoint {
  wsEndpoint: string;
  token?: string;
}

export interface CdpEndpointProvider {
  cdp: {
    getCdpEndpoint(): Promise<CdpEndpoint>;
  };
}

export async function connectPlaywright(endpoint: CdpEndpoint): Promise<any> {
  const connectOptions: { isElectronWebview: boolean; transportOptions?: { authToken: string } } = {
    isElectronWebview: true,
  };
  if (endpoint.token) connectOptions.transportOptions = { authToken: endpoint.token };
  return BrowserImpl.connect(endpoint.wsEndpoint, connectOptions);
}

export async function playwrightPage(handle: CdpEndpointProvider): Promise<any> {
  const browser = await connectPlaywright(await handle.cdp.getCdpEndpoint());
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) throw new Error("No page found in panel CDP target");
  return page;
}
