export type Browser = {
  contexts(): Array<{
    pages(): unknown[];
  }>;
};

export const BrowserImpl: {
  connect(wsEndpoint: string, options: object): Promise<Browser>;
};

export type Options = {
  headless?: boolean;
};

export function connect(
  wsEndpoint: string,
  browserName: string,
  options?: Options & { authToken?: string }
): Promise<Browser>;
