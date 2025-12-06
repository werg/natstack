/**
 * BrowserContextImpl - CDP-direct BrowserContext implementation
 * Simplified for single-session use case
 */

import type { BrowserImpl } from './browserImpl';
import type { PageImpl } from './pageImpl';

/**
 * CDP-direct BrowserContext implementation
 * Manages pages within a browsing context
 */
export class BrowserContextImpl {
  private _browser: BrowserImpl;
  private _contextId?: string;
  private _pages: PageImpl[] = [];

  constructor(browser: BrowserImpl, contextId?: string) {
    this._browser = browser;
    this._contextId = contextId;
  }

  /**
   * Get all pages in this context
   */
  pages(): PageImpl[] {
    return [...this._pages];
  }

  /**
   * Add a page to this context (internal)
   */
  _addPage(page: PageImpl): void {
    this._pages.push(page);
  }

  /**
   * Remove a page from this context (internal)
   */
  _removePage(page: PageImpl): void {
    const index = this._pages.indexOf(page);
    if (index !== -1) {
      this._pages.splice(index, 1);
    }
  }

  /**
   * Create a new page in this context
   */
  async newPage(): Promise<PageImpl> {
    const result = await this._browser._getConnection().rootSession.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId: this._contextId,
    });

    const page = await this._browser._attachToTarget(result.targetId);
    this._addPage(page);
    return page;
  }

  /**
   * Close this browser context
   */
  async close(): Promise<void> {
    if (this._contextId) {
      await this._browser._getConnection().rootSession.send('Target.disposeBrowserContext', {
        browserContextId: this._contextId,
      });
    }
  }

  /**
   * Get the browser that owns this context
   */
  browser(): BrowserImpl {
    return this._browser;
  }

  /**
   * Get the context ID
   */
  _getContextId(): string | undefined {
    return this._contextId;
  }
}
