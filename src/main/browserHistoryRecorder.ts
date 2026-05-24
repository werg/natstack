import { createDevLogger } from "@natstack/dev-log";
import { createBrowserDataRpcClient, type BrowserDataClient } from "@natstack/browser-data";
import {
  canonicalizeBrowserHistoryUrl,
  type BrowserNavigationIntent,
} from "@natstack/shared/panelCommands";
import type { ServerClient } from "./serverClient.js";

const log = createDevLogger("BrowserHistoryRecorder");
const DUPLICATE_WINDOW_MS = 1_000;

export type { BrowserNavigationIntent };

export class BrowserHistoryRecorder {
  private readonly pendingIntent = new Map<string, BrowserNavigationIntent>();
  private readonly recentRecords = new Map<string, number>();
  private readonly browserData: BrowserDataClient;

  constructor(serverClient: ServerClient) {
    this.browserData = createBrowserDataRpcClient(serverClient);
  }

  markNext(panelId: string, intent: BrowserNavigationIntent): void {
    this.pendingIntent.set(panelId, intent);
  }

  recordNavigation(panelId: string, url: string, title?: string): void {
    if (!/^https?:\/\//i.test(url)) return;
    const intent = this.pendingIntent.get(panelId) ?? {};
    this.pendingIntent.delete(panelId);
    const transition = intent.transition ?? "link";
    const key = `${panelId}:${transition}:${canonicalizeBrowserHistoryUrl(url) ?? url}`;
    const now = Date.now();
    const previous = this.recentRecords.get(key);
    if (previous && now - previous < DUPLICATE_WINDOW_MS) return;
    this.recentRecords.set(key, now);
    void this.browserData.history
      .recordVisit({
        url,
        title,
        transition,
        typed: Boolean(intent.typed),
        visitTime: now,
      })
      .catch((error: unknown) => {
        log.warn(
          `Failed to record browser history: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }

  updateTitle(url: string, title: string): void {
    if (!/^https?:\/\//i.test(url) || !title.trim()) return;
    void this.browserData.history
      .updateTitle({
        url,
        title,
        observedAt: Date.now(),
      })
      .catch((error: unknown) => {
        log.warn(
          `Failed to update browser history title: ${error instanceof Error ? error.message : String(error)}`
        );
      });
  }
}
