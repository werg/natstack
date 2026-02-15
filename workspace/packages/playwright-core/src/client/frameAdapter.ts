/**
 * Frame Adapter - bridges Frame API to direct CDP calls
 * Provides core waiting and selector evaluation logic ported from server-side frames.ts
 */

import { CDPAdapter } from './cdpAdapter';
import type { CRSession } from '../server/chromium/crConnection';

export interface WaitForSelectorOptions {
  timeout?: number;
  state?: 'attached' | 'detached' | 'visible' | 'hidden';
}

export interface QueryOptions {
  strict?: boolean;
}

/**
 * Timing utilities (ported from server helpers)
 */
function monotonicTime(): number {
  return performance.now();
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Frame adapter that implements waiting and selector logic for direct CDP
 */
export class FrameAdapter {
  private adapter: CDPAdapter;
  private defaultTimeout: number = 30000;
  private retryDelays = [0, 20, 50, 100, 100, 500];

  constructor(session: CRSession) {
    this.adapter = new CDPAdapter(session);
  }

  /**
   * Evaluate selector using InjectedScript
   * Returns elements matching the selector
   */
  async evaluateSelector(
    selector: string,
    options: QueryOptions = {}
  ): Promise<any[]> {
    // This will be implemented once InjectedScript is available
    // For now, return placeholder
    try {
      const result = await this.adapter.evaluate<any>({
        expression: `
          (() => {
            // Placeholder - will be replaced with actual selector evaluation
            return document.querySelectorAll('${selector}');
          })()
        `,
        returnByValue: true,
      });
      return result ? Array.from(result) : [];
    } catch (e) {
      return [];
    }
  }

  /**
   * Wait for selector with polling and timeout
   * Implements core polling logic from server-side waitForSelector
   */
  async waitForSelector(
    selector: string,
    options: WaitForSelectorOptions = {}
  ): Promise<boolean> {
    const { state = 'visible', timeout = this.defaultTimeout } = options;

    if (!['attached', 'detached', 'visible', 'hidden'].includes(state)) {
      throw new Error(`Invalid state: ${state}. Expected one of: attached, detached, visible, hidden`);
    }

    const deadline = monotonicTime() + timeout;
    let retryIndex = 0;

    while (true) {
      try {
        const found = await this.evaluateSelector(selector);
        const isAttached = found.length > 0;

        if (state === 'attached' && isAttached) return true;
        if (state === 'detached' && !isAttached) return true;

        // For visibility checks, would need element visibility detection via CDP
        // For now, treat attached as visible
        if (state === 'visible' && isAttached) return true;
        if (state === 'hidden' && !isAttached) return true;
      } catch (e) {
        // Continue polling on errors
      }

      const now = monotonicTime();
      if (now >= deadline) {
        throw new Error(
          `Timeout ${timeout}ms exceeded while waiting for selector "${selector}" to be ${state}`
        );
      }

      // Retry with exponential backoff
      const delay = this.retryDelays[Math.min(retryIndex++, this.retryDelays.length - 1)];
      await sleep(delay);
    }
  }

  /**
   * Query selector once (no polling)
   */
  async querySelector(selector: string, options: QueryOptions = {}): Promise<boolean> {
    try {
      const results = await this.evaluateSelector(selector, options);
      return results.length > 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * Get the CDP adapter for direct access to lower-level operations
   */
  getAdapter(): CDPAdapter {
    return this.adapter;
  }

  /**
   * Set default timeout for operations
   */
  setDefaultTimeout(ms: number): void {
    this.defaultTimeout = ms;
  }
}
