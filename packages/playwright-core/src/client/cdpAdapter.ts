/**
 * CDP Adapter - bridges Playwright API to direct CDP calls
 * Replaces ChannelOwner RPC pattern for browser-based CDP client
 */

import { InjectedScriptLoader } from './injectedScriptLoader';
import type { CRSession } from '../server/chromium/crConnection';
import type { Protocol } from '../server/chromium/protocol';

export interface EvaluateOptions {
  expression: string;
  returnByValue?: boolean;
  awaitPromise?: boolean;
  args?: any[];
}

export interface EvaluateResult<T = any> {
  result?: {
    type: string;
    value?: T;
    objectId?: string;
    description?: string;
  };
  exceptionDetails?: Protocol.Runtime.ExceptionDetails;
}

export class CDPAdapter {
  private injectedScriptLoader: InjectedScriptLoader;

  constructor(private session: CRSession) {
    this.injectedScriptLoader = new InjectedScriptLoader(this);
  }

  /**
   * Evaluate JavaScript expression in the page context
   */
  async evaluate<T = any>(options: EvaluateOptions): Promise<T> {
    const result = await this.session.send('Runtime.evaluate', {
      expression: options.expression,
      returnByValue: options.returnByValue ?? true,
      awaitPromise: options.awaitPromise ?? true,
      userGesture: true,
    } as any);

    if (result.exceptionDetails) {
      throw new Error(`Evaluation failed: ${result.exceptionDetails.text || 'Unknown error'}`);
    }

    return result.result?.value as T;
  }

  /**
   * Evaluate expression with a specific argument
   */
  async evaluateWithArg<T = any>(
    expression: string,
    arg: any
  ): Promise<T> {
    // Serialize the argument and inject it
    const argJson = JSON.stringify(arg);
    const wrappedExpression = `(function(arg) { ${expression} })(${argJson})`;
    return this.evaluate<T>({ expression: wrappedExpression });
  }

  /**
   * Get the injected script loader
   */
  getInjectedScriptLoader(): InjectedScriptLoader {
    return this.injectedScriptLoader;
  }

  /**
   * Enable required CDP domains
   */
  async enableDomains(): Promise<void> {
    await Promise.all([
      this.session.send('Runtime.enable'),
      this.session.send('Page.enable'),
      this.session.send('DOM.enable'),
      this.session.send('CSS.enable'),
      this.session.send('Input.enable'),
      this.session.send('Network.enable'),
    ] as any[]);
  }

  /**
   * Get the current execution context ID
   */
  async getContextId(): Promise<number> {
    const result = await this.session.send('Runtime.evaluate', {
      expression: '1',
      returnByValue: true,
    } as any);

    // Context ID is not directly returned, but we can track it via Runtime.executionContextCreated
    // For now, use a default. This will be improved in Phase 2
    return 1;
  }

  /**
   * Get the root document element
   */
  async getDocumentElement(): Promise<string> {
    const result = await this.session.send('DOM.getDocument') as any;
    return result?.root?.nodeId;
  }

  /**
   * Query selector and get node ID
   */
  async querySelector(selector: string): Promise<string | null> {
    const result = await this.session.send('DOM.getDocument') as any;
    if (!result?.root?.nodeId) return null;

    const queryResult = await this.session.send('DOM.querySelector', {
      nodeId: result.root.nodeId,
      selector,
    } as any);

    return queryResult?.nodeId || null;
  }

  /**
   * Get the backing object ID for a node ID
   */
  async getObjectIdForNode(nodeId: number): Promise<string | null> {
    const result = await this.session.send('DOM.resolveNode', {
      nodeId,
    } as any);

    return result?.object?.objectId || null;
  }

  /**
   * Release a remote object reference
   */
  async releaseObject(objectId: string): Promise<void> {
    await this.session.send('Runtime.releaseObject', {
      objectId,
    } as any);
  }

  /**
   * Get the CDP session
   */
  getSession(): CRSession {
    return this.session;
  }
}
