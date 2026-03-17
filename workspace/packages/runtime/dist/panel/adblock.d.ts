/**
 * Ad blocking programmatic interface for panels.
 *
 * Provides a clean API for panels to interact with the ad blocking system,
 * including per-panel stats and control.
 */
import type { RpcBridge } from "@natstack/rpc";
/**
 * Ad blocking statistics.
 */
export interface AdBlockStats {
    blockedRequests: number;
    blockedElements: number;
}
/**
 * Ad blocking API interface.
 */
export interface AdBlockApi {
    /** Get global ad blocking statistics */
    getStats(): Promise<AdBlockStats>;
    /** Check if ad blocking is globally active */
    isActive(): Promise<boolean>;
    /** Get ad blocking statistics for a specific panel */
    getStatsForPanel(webContentsId: number): Promise<AdBlockStats>;
    /** Check if ad blocking is enabled for a specific panel */
    isEnabledForPanel(webContentsId: number): Promise<boolean>;
    /** Enable or disable ad blocking for a specific panel */
    setEnabledForPanel(webContentsId: number, enabled: boolean): Promise<void>;
    /** Reset statistics for a specific panel */
    resetStatsForPanel(webContentsId: number): Promise<void>;
    /** Get the URL currently being tracked for a panel */
    getPanelUrl(webContentsId: number): Promise<string | undefined>;
    /** Add a domain to the global whitelist (supports wildcards like *.example.com) */
    addToWhitelist(domain: string): Promise<void>;
    /** Remove a domain from the global whitelist */
    removeFromWhitelist(domain: string): Promise<void>;
}
/**
 * Create the ad blocking API using the provided RPC bridge.
 */
export declare function createAdBlockApi(rpc: RpcBridge): AdBlockApi;
//# sourceMappingURL=adblock.d.ts.map