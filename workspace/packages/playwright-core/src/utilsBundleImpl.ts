// Browser-friendly stub implementations for utilsBundle dependencies.
// These satisfy type expectations while avoiding Node/polyfill imports in the browser bundle.

export const colors: any = {};

export const debug: any = (() => {
  const fn: any = () => {};
  fn.enabled = () => false;
  return fn;
})();

export const diff: any = {};
export const dotenv: any = { config: () => ({}) };
export const getProxyForUrl = (_url: string) => undefined;

export const HttpsProxyAgent: any = class {};
export const SocksProxyAgent: any = class {};

export const jpegjs: any = {};
export const lockfile: any = {};
export const mime: any = {};
export const minimatch: any = () => false;
export const open: any = () => Promise.resolve();
export const PNG: any = {};
export const program: any = {};
export const ProgramOption: any = class {};
export const progress: any = {};
export const ws: any = (typeof WebSocket !== 'undefined' ? WebSocket : class {});
export const wsServer: any = class {};
export const wsReceiver: any = {};
export const wsSender: any = {};
export const yaml: any = {};
export const zod: any = {};
