import type { ImportedPassword } from "../types.js";
import type { StoredCookie, StoredPassword } from "../storage/types.js";

interface RpcLike {
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
}

export interface BrowserDataClient {
  cookies: {
    getByDomain(domain?: string): Promise<StoredCookie[]>;
  };
  passwords: {
    getForOrigin(origin: string): Promise<StoredPassword[]>;
    updateLastUsed(id: number): Promise<void>;
    update(id: number, partial: Partial<{ username: string; password: string; actionUrl: string; realm: string }>): Promise<void>;
    add(password: { url: string; username: string; password: string; actionUrl?: string; realm?: string }): Promise<number>;
    addNeverSave(origin: string): Promise<void>;
    isNeverSave(origin: string): Promise<boolean>;
  };
}

export function createBrowserDataRpcClient(
  rpc: RpcLike,
): BrowserDataClient {
  const call = <T>(method: string, ...args: unknown[]) => {
    return rpc.call("browser-data", method, args) as Promise<T>;
  };

  return {
    cookies: {
      getByDomain: (domain?: string) => call("getCookies", domain),
    },
    passwords: {
      getForOrigin: (origin: string) => call("getPasswordForSite", origin),
      updateLastUsed: (id: number) => call<void>("updatePasswordLastUsed", id),
      update: (id: number, partial: Partial<ImportedPassword>) => call("updatePassword", id, partial),
      add: (password) => call("addPassword", password),
      addNeverSave: (origin: string) => call<void>("addNeverSavePassword", origin),
      isNeverSave: (origin: string) => call<boolean>("isNeverSavePassword", origin),
    },
  };
}
