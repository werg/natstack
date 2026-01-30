/**
 * AdBlockManager - Native ad blocking using @ghostery/adblocker.
 *
 * Provides:
 * - Network request blocking via Electron's webRequest API
 * - Cosmetic filtering (element hiding via CSS injection)
 * - Configurable filter lists (EasyList, EasyPrivacy, etc.)
 * - Domain whitelisting
 * - Serialized engine cache for fast startup
 */

import { FiltersEngine, Request } from "@ghostery/adblocker";
import fetch from "cross-fetch";
import * as fs from "fs";
import * as path from "path";
import { session, ipcMain } from "electron";
import { parse } from "tldts";
import { getCentralConfigDirectory } from "../paths.js";
import { createDevLogger } from "../devLog.js";

const log = createDevLogger("AdBlock");

/**
 * Configuration for which filter lists are enabled.
 */
export interface AdBlockListConfig {
  ads: boolean; // EasyList
  privacy: boolean; // EasyPrivacy
  annoyances: boolean; // Fanboy's Annoyances
  social: boolean; // Fanboy's Social
}

/**
 * Full ad block configuration.
 */
export interface AdBlockConfig {
  enabled: boolean;
  lists: AdBlockListConfig;
  customLists: string[]; // URLs to custom filter lists
  whitelist: string[]; // Domains to whitelist
  lastUpdated?: number; // Timestamp of last filter list update (ms since epoch)
}

/**
 * Statistics about ad blocking activity.
 */
export interface AdBlockStats {
  blockedRequests: number;
  blockedElements: number;
}

/**
 * Default configuration with sensible defaults.
 */
const DEFAULT_CONFIG: AdBlockConfig = {
  enabled: true,
  lists: {
    ads: true,
    privacy: true,
    annoyances: false,
    social: false,
  },
  customLists: [],
  whitelist: [],
};

/**
 * Filter list URLs.
 */
const FILTER_LIST_URLS = {
  ads: "https://easylist.to/easylist/easylist.txt",
  privacy: "https://easylist.to/easylist/easyprivacy.txt",
  annoyances: "https://secure.fanboy.co.nz/fanboy-annoyance.txt",
  social: "https://easylist.to/easylist/fanboy-social.txt",
};

/**
 * IPC channel names for cosmetic filtering.
 */
const IPC_INJECT_COSMETICS = "natstack:adblock:inject-cosmetics";
const IPC_MUTATION_OBSERVER = "natstack:adblock:mutation-observer-enabled";

/**
 * Update interval for filter lists (24 hours in milliseconds).
 */
const FILTER_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export class AdBlockManager {
  private engine: FiltersEngine | null = null;
  private config: AdBlockConfig;
  private cachePath: string;
  private configPath: string;
  private enabledSessions = new Set<Electron.Session>();
  private stats: AdBlockStats = { blockedRequests: 0, blockedElements: 0 };
  private ipcHandlersRegistered = false;
  private updateTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Track main frame URLs by webContentsId for accurate whitelist checking.
   * Updated when main frame navigation completes.
   */
  private mainFrameUrls = new Map<number, string>();

  /**
   * Per-panel stats tracking (by webContentsId).
   */
  private panelStats = new Map<number, AdBlockStats>();

  /**
   * Per-panel disable list (webContentsIds where ad blocking is disabled).
   */
  private disabledPanels = new Set<number>();

  constructor() {
    const configDir = getCentralConfigDirectory();
    this.cachePath = path.join(configDir, "adblock-engine.bin");
    this.configPath = path.join(configDir, "adblock-config.json");
    this.config = this.loadConfig();
  }

  /**
   * Load configuration from disk or use defaults.
   */
  private loadConfig(): AdBlockConfig {
    try {
      if (fs.existsSync(this.configPath)) {
        const data = fs.readFileSync(this.configPath, "utf-8");
        const loaded = JSON.parse(data) as Partial<AdBlockConfig>;
        // Merge with defaults to handle missing fields
        return {
          ...DEFAULT_CONFIG,
          ...loaded,
          lists: { ...DEFAULT_CONFIG.lists, ...loaded.lists },
        };
      }
    } catch (error) {
      console.warn("[AdBlock] Failed to load config, using defaults:", error);
    }
    return { ...DEFAULT_CONFIG };
  }

  /**
   * Save configuration to disk.
   */
  private saveConfig(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2));
    } catch (error) {
      console.error("[AdBlock] Failed to save config:", error);
    }
  }

  /**
   * Get URLs for currently enabled filter lists.
   */
  private getActiveListUrls(): string[] {
    const lists: string[] = [];

    if (this.config.lists.ads) {
      lists.push(FILTER_LIST_URLS.ads);
    }
    if (this.config.lists.privacy) {
      lists.push(FILTER_LIST_URLS.privacy);
    }
    if (this.config.lists.annoyances) {
      lists.push(FILTER_LIST_URLS.annoyances);
    }
    if (this.config.lists.social) {
      lists.push(FILTER_LIST_URLS.social);
    }

    // Add custom lists
    lists.push(...this.config.customLists);

    return lists;
  }

  /**
   * Initialize the ad blocker.
   * Loads from cache if available, otherwise builds from filter lists.
   * Starts automatic filter list update timer.
   */
  async initialize(): Promise<void> {
    if (!this.config.enabled) {
      console.log("[AdBlock] Disabled by configuration");
      return;
    }

    // Try to load from cache first (fast startup)
    if (fs.existsSync(this.cachePath)) {
      try {
        const data = fs.readFileSync(this.cachePath);
        this.engine = FiltersEngine.deserialize(new Uint8Array(data));
        console.log("[AdBlock] Loaded from cache");
        // Start update timer even when loading from cache
        this.startUpdateTimer();
        return;
      } catch (error) {
        console.warn("[AdBlock] Cache invalid, rebuilding...", error);
      }
    }

    // Build from filter lists
    await this.rebuildEngine();
    // Start automatic update timer
    this.startUpdateTimer();
  }

  /**
   * Start the automatic filter list update timer.
   * Updates filter lists every 24 hours.
   */
  private startUpdateTimer(): void {
    // Clear existing timer if any
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
    }

    this.updateTimer = setInterval(async () => {
      if (!this.config.enabled) {
        return;
      }
      console.log("[AdBlock] Starting scheduled filter list update...");
      try {
        await this.rebuildEngine();
        console.log("[AdBlock] Scheduled filter list update complete");
      } catch (error) {
        console.error("[AdBlock] Scheduled filter list update failed:", error);
      }
    }, FILTER_UPDATE_INTERVAL_MS);

    console.log("[AdBlock] Automatic filter list updates enabled (24h interval)");
  }

  /**
   * Stop the automatic filter list update timer.
   */
  private stopUpdateTimer(): void {
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
      console.log("[AdBlock] Automatic filter list updates disabled");
    }
  }

  /**
   * Rebuild the blocking engine from filter lists.
   */
  async rebuildEngine(): Promise<void> {
    const lists = this.getActiveListUrls();

    if (lists.length === 0) {
      console.log("[AdBlock] No filter lists enabled, skipping build");
      this.engine = null;
      return;
    }

    log.info(` Building engine from ${lists.length} filter lists...`);

    try {
      this.engine = await FiltersEngine.fromLists(fetch, lists, {
        enableCompression: true,
      });

      // Cache for fast startup
      const serialized = this.engine.serialize();
      fs.writeFileSync(this.cachePath, Buffer.from(serialized));

      // Update lastUpdated timestamp
      this.config.lastUpdated = Date.now();
      this.saveConfig();

      console.log("[AdBlock] Engine built and cached");

      // Note: Sessions that were previously enabled will continue to work
      // because the handlers reference this.engine which has been updated
    } catch (error) {
      console.error("[AdBlock] Failed to build engine:", error);
      throw error;
    }
  }

  /**
   * Create a Request object from Electron webRequest details.
   */
  private createRequest(
    details: Electron.OnBeforeRequestListenerDetails | Electron.OnHeadersReceivedListenerDetails
  ): Request {
    const { id, url, resourceType, referrer, webContentsId } = details;
    return Request.fromRawDetails(
      webContentsId
        ? {
            requestId: `${id}`,
            sourceUrl: referrer,
            tabId: webContentsId,
            type: (resourceType || "other") as Request["type"],
            url,
          }
        : {
            requestId: `${id}`,
            sourceUrl: referrer,
            type: (resourceType || "other") as Request["type"],
            url,
          }
    );
  }

  /**
   * Get the page URL for whitelist checking.
   * Uses tracked main frame URL if available, falls back to referrer or request URL.
   */
  private getPageUrlForWhitelist(details: Electron.OnBeforeRequestListenerDetails | Electron.OnHeadersReceivedListenerDetails): string {
    // First try the tracked main frame URL for this webContents
    if (details.webContentsId) {
      const mainFrameUrl = this.mainFrameUrls.get(details.webContentsId);
      if (mainFrameUrl) {
        return mainFrameUrl;
      }
    }
    // Fall back to referrer or request URL
    return details.referrer || details.url;
  }

  /**
   * Enable ad blocking for a session.
   * Sets up webRequest handlers with whitelist support.
   * Handlers check config.enabled on each request for efficient enable/disable.
   */
  enableForSession(ses: Electron.Session = session.defaultSession): void {
    if (!this.engine) {
      console.warn("[AdBlock] Cannot enable - engine not initialized");
      return;
    }

    if (this.enabledSessions.has(ses)) {
      return;
    }

    // Set up network request blocking
    // Handler checks config.enabled to allow efficient disable without removing handlers
    ses.webRequest.onBeforeRequest({ urls: ["<all_urls>"] }, (details, callback) => {
      // Fast path: if ad blocking is disabled, pass through immediately
      if (!this.config.enabled || !this.engine) {
        callback({ cancel: false });
        return;
      }

      const request = this.createRequest(details);

      // Track main frame URLs for accurate whitelist checking
      if (request.isMainFrame() && details.webContentsId) {
        this.mainFrameUrls.set(details.webContentsId, details.url);
        callback({});
        return;
      }

      // Check if this specific panel has ad blocking disabled
      if (details.webContentsId && this.disabledPanels.has(details.webContentsId)) {
        callback({ cancel: false });
        return;
      }

      // Check if the page URL is whitelisted
      const pageUrl = this.getPageUrlForWhitelist(details);
      if (this.isWhitelisted(pageUrl)) {
        callback({ cancel: false });
        return;
      }

      const { redirect, match } = this.engine.match(request);

      if (redirect) {
        callback({ redirectURL: redirect.dataUrl });
        this.incrementStats(details.webContentsId, "blockedRequests");
      } else if (match) {
        callback({ cancel: true });
        this.incrementStats(details.webContentsId, "blockedRequests");
      } else {
        callback({});
      }
    });

    // Set up header modification for CSP injection
    ses.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
      // Fast path: if ad blocking is disabled, pass through immediately
      if (!this.config.enabled || !this.engine) {
        callback({});
        return;
      }

      const pageUrl = this.getPageUrlForWhitelist(details);
      if (this.isWhitelisted(pageUrl)) {
        callback({});
        return;
      }

      const CSP_HEADER_NAME = "content-security-policy";
      const policies: string[] = [];
      const responseHeaders = details.responseHeaders || {};

      if (details.resourceType === "mainFrame" || details.resourceType === "subFrame") {
        const rawCSP = this.engine.getCSPDirectives(this.createRequest(details));
        if (rawCSP !== undefined) {
          policies.push(...rawCSP.split(";").map((csp) => csp.trim()));

          // Collect existing CSP headers from response
          for (const [name, values] of Object.entries(responseHeaders)) {
            if (name.toLowerCase() === CSP_HEADER_NAME) {
              policies.push(...values);
              delete responseHeaders[name];
            }
          }

          responseHeaders[CSP_HEADER_NAME] = [policies.join(";")];
          callback({ responseHeaders });
          return;
        }
      }

      callback({});
    });

    // Set up IPC handlers for cosmetic filtering (only once)
    this.setupCosmeticFilteringIpc();

    this.enabledSessions.add(ses);
    console.log("[AdBlock] Enabled for session with whitelist support");
  }

  /**
   * Set up IPC handlers for cosmetic filtering.
   * These handlers inject CSS and scripts to hide ad elements.
   */
  private setupCosmeticFilteringIpc(): void {
    if (this.ipcHandlersRegistered) {
      return;
    }

    // Handler for injecting cosmetic filters
    ipcMain.handle(
      IPC_INJECT_COSMETICS,
      async (
        event: Electron.IpcMainInvokeEvent,
        url: string,
        msg?: { classes?: string[]; hrefs?: string[]; ids?: string[]; lifecycle?: string }
      ) => {
        // Check if ad blocking is enabled
        if (!this.config.enabled || !this.engine) {
          return;
        }

        // Check if webContents is still valid
        if (event.sender.isDestroyed()) {
          return;
        }

        const webContentsId = event.sender.id;

        // Check if this specific panel has ad blocking disabled
        if (this.disabledPanels.has(webContentsId)) {
          return;
        }

        // Check whitelist
        if (this.isWhitelisted(url)) {
          return;
        }

        const parsed = parse(url);
        const hostname = parsed.hostname || "";
        const domain = parsed.domain || "";

        const isFirstRun = msg === undefined;
        const { active, styles, scripts } = this.engine.getCosmeticsFilters({
          domain,
          hostname,
          url,
          classes: msg?.classes,
          hrefs: msg?.hrefs,
          ids: msg?.ids,
          getBaseRules: isFirstRun,
          getInjectionRules: isFirstRun,
          getExtendedRules: false,
          getRulesFromHostname: isFirstRun,
          getRulesFromDOM: !isFirstRun,
        });

        if (active === false) {
          return;
        }

        // Inject CSS to hide elements
        if (styles.length > 0) {
          try {
            // Double-check webContents is still valid before injection
            if (!event.sender.isDestroyed()) {
              await event.sender.insertCSS(styles, { cssOrigin: "user" });
              // Count rules applied (rough estimate: count selectors)
              const elementCount = (styles.match(/,/g) || []).length + 1;
              this.incrementStats(webContentsId, "blockedElements", elementCount);
            }
          } catch (e) {
            // Silently ignore errors from destroyed webContents
            if (!String(e).includes("destroyed")) {
              console.error("[AdBlock] Failed to inject CSS:", e);
            }
          }
        }

        // Execute scripts (scriptlets)
        for (const script of scripts) {
          try {
            if (!event.sender.isDestroyed()) {
              await event.sender.executeJavaScript(script, true);
            }
          } catch (e) {
            if (!String(e).includes("destroyed")) {
              console.error("[AdBlock] Scriptlet crashed:", e);
            }
          }
        }
      }
    );

    // Handler for checking if mutation observer should be enabled
    // Return true to enable dynamic cosmetic filtering updates
    ipcMain.handle(IPC_MUTATION_OBSERVER, async () => {
      if (!this.config.enabled) {
        return false;
      }
      // Enable mutation observer for dynamic content filtering
      return true;
    });

    this.ipcHandlersRegistered = true;
    console.log("[AdBlock] Cosmetic filtering IPC handlers registered");
  }

  /**
   * Disable ad blocking for a session.
   * Note: Handlers remain registered but check config.enabled for efficiency.
   * This avoids the overhead of setting pass-through handlers on every request.
   */
  disableForSession(ses: Electron.Session = session.defaultSession): void {
    if (!this.enabledSessions.has(ses)) {
      return;
    }

    // Clear tracked main frame URLs for this session
    // Note: We can't easily identify which webContentsIds belong to this session,
    // so we keep the map entries (they'll be overwritten on next navigation)

    this.enabledSessions.delete(ses);
    console.log("[AdBlock] Disabled for session (handlers check config.enabled)");
  }

  /**
   * Clean up main frame URL tracking for a destroyed webContents.
   * Called when a browser panel is closed.
   */
  clearMainFrameUrl(webContentsId: number): void {
    this.mainFrameUrls.delete(webContentsId);
    this.panelStats.delete(webContentsId);
    this.disabledPanels.delete(webContentsId);
  }

  /**
   * Increment a stat counter for both global and per-panel tracking.
   */
  private incrementStats(webContentsId: number | undefined, stat: keyof AdBlockStats, amount: number = 1): void {
    // Increment global stats
    this.stats[stat] += amount;

    // Increment per-panel stats if webContentsId is available
    if (webContentsId) {
      let panelStat = this.panelStats.get(webContentsId);
      if (!panelStat) {
        panelStat = { blockedRequests: 0, blockedElements: 0 };
        this.panelStats.set(webContentsId, panelStat);
      }
      panelStat[stat] += amount;
    }
  }

  /**
   * Check if a domain is whitelisted.
   */
  isWhitelisted(url: string): boolean {
    try {
      const hostname = new URL(url).hostname;
      return this.config.whitelist.some((pattern) => {
        if (pattern.startsWith("*.")) {
          return hostname.endsWith(pattern.slice(1));
        }
        return hostname === pattern;
      });
    } catch {
      return false;
    }
  }

  /**
   * Get the IPC channel name for cosmetic filter injection.
   * Used by preload scripts to communicate with the ad blocker.
   */
  static getInjectCosmeticsChannel(): string {
    return IPC_INJECT_COSMETICS;
  }

  /**
   * Get the IPC channel name for mutation observer check.
   */
  static getMutationObserverChannel(): string {
    return IPC_MUTATION_OBSERVER;
  }

  // =========================================================================
  // Public API (called via IPC)
  // =========================================================================

  /**
   * Get current configuration.
   */
  getConfig(): AdBlockConfig {
    return { ...this.config };
  }

  /**
   * Set enabled state.
   */
  async setEnabled(enabled: boolean): Promise<void> {
    if (this.config.enabled === enabled) return;

    this.config.enabled = enabled;
    this.saveConfig();

    if (enabled) {
      await this.initialize();
      // Enable for default session
      this.enableForSession(session.defaultSession);
    } else {
      // Stop automatic updates
      this.stopUpdateTimer();
      // Disable for all sessions (handlers will check config.enabled)
      for (const ses of this.enabledSessions) {
        this.disableForSession(ses);
      }
    }
  }

  /**
   * Enable or disable a specific filter list.
   */
  async setListEnabled(list: keyof AdBlockListConfig, enabled: boolean): Promise<void> {
    if (this.config.lists[list] === enabled) return;

    this.config.lists[list] = enabled;
    this.saveConfig();

    // Rebuild engine with new list configuration
    if (this.config.enabled) {
      await this.rebuildEngine();
    }
  }

  /**
   * Add a custom filter list URL.
   */
  async addCustomList(url: string): Promise<void> {
    if (this.config.customLists.includes(url)) return;

    this.config.customLists.push(url);
    this.saveConfig();

    if (this.config.enabled) {
      await this.rebuildEngine();
    }
  }

  /**
   * Remove a custom filter list URL.
   */
  async removeCustomList(url: string): Promise<void> {
    const index = this.config.customLists.indexOf(url);
    if (index === -1) return;

    this.config.customLists.splice(index, 1);
    this.saveConfig();

    if (this.config.enabled) {
      await this.rebuildEngine();
    }
  }

  /**
   * Add a domain to the whitelist.
   */
  addToWhitelist(domain: string): void {
    if (this.config.whitelist.includes(domain)) return;

    this.config.whitelist.push(domain);
    this.saveConfig();
  }

  /**
   * Remove a domain from the whitelist.
   */
  removeFromWhitelist(domain: string): void {
    const index = this.config.whitelist.indexOf(domain);
    if (index === -1) return;

    this.config.whitelist.splice(index, 1);
    this.saveConfig();
  }

  /**
   * Get blocking statistics.
   */
  getStats(): AdBlockStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics.
   */
  resetStats(): void {
    this.stats = { blockedRequests: 0, blockedElements: 0 };
  }

  /**
   * Check if ad blocking is currently active.
   */
  isActive(): boolean {
    return this.config.enabled && this.engine !== null;
  }

  // =========================================================================
  // Per-Panel API (for programmatic control from panels)
  // =========================================================================

  /**
   * Get stats for a specific panel (by webContentsId).
   */
  getStatsForPanel(webContentsId: number): AdBlockStats {
    const stats = this.panelStats.get(webContentsId);
    return stats ? { ...stats } : { blockedRequests: 0, blockedElements: 0 };
  }

  /**
   * Check if ad blocking is enabled for a specific panel.
   */
  isEnabledForPanel(webContentsId: number): boolean {
    return this.config.enabled && !this.disabledPanels.has(webContentsId);
  }

  /**
   * Enable or disable ad blocking for a specific panel.
   * This allows individual panels to opt out of ad blocking.
   */
  setEnabledForPanel(webContentsId: number, enabled: boolean): void {
    if (enabled) {
      this.disabledPanels.delete(webContentsId);
      log.info(` Enabled for panel ${webContentsId}`);
    } else {
      this.disabledPanels.add(webContentsId);
      log.info(` Disabled for panel ${webContentsId}`);
    }
  }

  /**
   * Reset stats for a specific panel.
   */
  resetStatsForPanel(webContentsId: number): void {
    this.panelStats.delete(webContentsId);
  }

  /**
   * Get the URL currently being tracked for a panel (the main frame URL).
   * Useful for UI that wants to show what domain is being blocked.
   */
  getPanelUrl(webContentsId: number): string | undefined {
    return this.mainFrameUrls.get(webContentsId);
  }
}

// Singleton instance
let instance: AdBlockManager | null = null;

/**
 * Get the singleton AdBlockManager instance.
 */
export function getAdBlockManager(): AdBlockManager {
  if (!instance) {
    instance = new AdBlockManager();
  }
  return instance;
}
