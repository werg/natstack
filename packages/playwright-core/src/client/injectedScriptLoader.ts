/**
 * InjectedScript Loader - manages loading and caching of InjectedScript in page context
 *
 * The InjectedScript needs to be evaluated once per execution context and cached,
 * then reused for all selector queries and element operations.
 */

import type { CDPAdapter } from './cdpAdapter';

export interface InjectedScriptAPI {
  querySelector: (selector: any, root: Node, strict: boolean) => Element | undefined;
  querySelectorAll: (selector: any, root: Node) => Element[];
  utils: {
    isElementVisible: (element: Element) => boolean;
  };
}

/**
 * Manages InjectedScript lifecycle per CDP session
 */
export class InjectedScriptLoader {
  private contextToScript = new Map<number, InjectedScriptAPI>();
  private contextToModulePromise = new Map<number, Promise<InjectedScriptAPI>>();

  constructor(private adapter: CDPAdapter) {}

  /**
   * Get or load InjectedScript for a given execution context
   */
  async getInjectedScript(contextId: number): Promise<InjectedScriptAPI> {
    // Return cached instance if available
    if (this.contextToScript.has(contextId)) {
      return this.contextToScript.get(contextId)!;
    }

    // Return pending promise if already loading
    if (this.contextToModulePromise.has(contextId)) {
      return this.contextToModulePromise.get(contextId)!;
    }

    // Start loading
    const loadPromise = this.loadInjectedScript(contextId);
    this.contextToModulePromise.set(contextId, loadPromise);

    try {
      const script = await loadPromise;
      this.contextToScript.set(contextId, script);
      return script;
    } finally {
      this.contextToModulePromise.delete(contextId);
    }
  }

  /**
   * Load InjectedScript for a context by evaluating the module
   */
  private async loadInjectedScript(contextId: number): Promise<InjectedScriptAPI> {
    // This will be implemented by importing from @natstack/playwright-injected
    // For now, return a stub that we'll enhance in Phase 3

    // Stub implementation that uses native DOM queries
    return {
      querySelector: (selector: any, root: Node, strict: boolean) => {
        if (!root) return undefined;
        if (typeof selector === 'string') {
          return (root as Document | Element).querySelector(selector) || undefined;
        }
        // Simplified - full implementation uses ParsedSelector
        return undefined;
      },
      querySelectorAll: (selector: any, root: Node) => {
        if (!root) return [];
        if (typeof selector === 'string') {
          return Array.from((root as Document | Element).querySelectorAll(selector));
        }
        // Simplified - full implementation uses ParsedSelector
        return [];
      },
      utils: {
        isElementVisible: (element: Element) => {
          // Simple visibility check
          const style = window.getComputedStyle(element);
          return style.display !== 'none' && style.visibility !== 'hidden';
        },
      },
    };
  }

  /**
   * Clear cached scripts (e.g., when context is destroyed)
   */
  clearContext(contextId: number): void {
    this.contextToScript.delete(contextId);
    this.contextToModulePromise.delete(contextId);
  }

  /**
   * Clear all cached scripts
   */
  clearAll(): void {
    this.contextToScript.clear();
    this.contextToModulePromise.clear();
  }
}
