/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { SdkObject } from '../instrumentation';
import { JSHandle, ElementHandle } from './crHandle';
import { Locator } from './locator';

import type { CRPage } from './crBrowser';
import type { Protocol } from './protocol';
import type { CRSession } from './crConnection';
import type { LocatorOptions, ByRoleOptions } from './locator';
import type * as types from '../types';

/**
 * Simplified Frame class for browser-based CDP connections.
 * This implementation focuses on basic frame operations that work via CDP.
 */
export class Frame extends SdkObject {
  readonly _page: CRPage;
  _id: string;
  private _parentFrame: Frame | null;
  readonly _childFrames = new Set<Frame>();
  private _url = '';
  private _name = '';
  private _detached = false;
  _session: CRSession;

  constructor(page: CRPage, frameId: string, parentFrame: Frame | null, session: CRSession) {
    super(page, 'frame');
    this._page = page;
    this._id = frameId;
    this._parentFrame = parentFrame;
    this._session = session;
    if (this._parentFrame)
      this._parentFrame._childFrames.add(this);
  }

  _updateFromFramePayload(payload: Protocol.Page.Frame) {
    this._url = payload.url + (payload.urlFragment || '');
    this._name = payload.name || '';
  }

  _detach() {
    this._detached = true;
    if (this._parentFrame)
      this._parentFrame._childFrames.delete(this);
  }

  /**
   * Returns the frame's URL.
   */
  url(): string {
    return this._url;
  }

  /**
   * Returns the frame's name attribute.
   */
  name(): string {
    return this._name;
  }

  /**
   * Returns the parent frame, or null if this is the main frame.
   */
  parentFrame(): Frame | null {
    return this._parentFrame;
  }

  /**
   * Returns an array of child frames.
   */
  childFrames(): Frame[] {
    return Array.from(this._childFrames);
  }

  /**
   * Returns whether the frame has been detached.
   */
  isDetached(): boolean {
    return this._detached;
  }

  /**
   * Returns the page that owns this frame.
   */
  page(): CRPage {
    return this._page;
  }

  /**
   * Navigate the frame to a URL.
   */
  async goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'; timeout?: number }): Promise<void> {
    // For the main frame, delegate to page
    if (!this._parentFrame) {
      return this._page.goto(url, options);
    }

    // For subframes, use evaluate to navigate
    await this.evaluate((url: string) => {
      window.location.href = url;
    }, url);
  }

  /**
   * Get the frame's HTML content.
   */
  async content(): Promise<string> {
    return this.evaluate(() => document.documentElement.outerHTML);
  }

  /**
   * Set the frame's HTML content.
   */
  async setContent(html: string): Promise<void> {
    await this.evaluate((html: string) => {
      document.open();
      document.write(html);
      document.close();
    }, html);
  }

  /**
   * Get the frame's title.
   */
  async title(): Promise<string> {
    return this.evaluate(() => document.title);
  }

  /**
   * Evaluate JavaScript in the frame context.
   */
  async evaluate<T = unknown>(expression: string | ((...args: unknown[]) => T), ...args: unknown[]): Promise<T> {
    let evalExpression: string;

    if (typeof expression === 'function') {
      const argsJson = args.map(arg => JSON.stringify(arg)).join(', ');
      evalExpression = `(${expression.toString()})(${argsJson})`;
    } else {
      evalExpression = expression;
    }

    const result = await this._session.send('Runtime.evaluate', {
      expression: evalExpression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      const errorMsg = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`Evaluation failed: ${errorMsg}`);
    }

    return result.result.value as T;
  }

  /**
   * Query for a single element.
   */
  async $(selector: string): Promise<ElementHandle | null> {
    const result = await this._session.send('Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(selector)})`,
      returnByValue: false,
    });

    if (!result.result.objectId)
      return null;

    return new ElementHandle(this._page, this._session, result.result.objectId, result.result.description);
  }

  /**
   * Query for all matching elements.
   */
  async $$(selector: string): Promise<ElementHandle[]> {
    const result = await this._session.send('Runtime.evaluate', {
      expression: `Array.from(document.querySelectorAll(${JSON.stringify(selector)}))`,
      returnByValue: false,
    });

    if (!result.result.objectId)
      return [];

    const arrayHandle = new JSHandle(this._page, this._session, result.result.objectId);
    const properties = await arrayHandle.getProperties();
    await arrayHandle.dispose();

    const elements: ElementHandle[] = [];
    for (const [key, handle] of properties) {
      if (!isNaN(Number(key)) && (handle as any)._objectId) {
        elements.push(new ElementHandle(this._page, this._session, (handle as any)._objectId));
      }
    }

    return elements;
  }

  /**
   * Evaluate on a queried element.
   */
  async $eval<R>(selector: string, pageFunction: (el: Element, ...args: unknown[]) => R, ...args: unknown[]): Promise<R> {
    const element = await this.$(selector);
    if (!element)
      throw new Error(`Element not found: ${selector}`);

    try {
      return await element.evaluate(pageFunction as (arg: Element, ...args: unknown[]) => R, ...args);
    } finally {
      await element.dispose();
    }
  }

  /**
   * Evaluate on all queried elements.
   */
  async $$eval<R>(selector: string, pageFunction: (els: Element[], ...args: unknown[]) => R, ...args: unknown[]): Promise<R> {
    const argsJson = args.map(arg => JSON.stringify(arg)).join(', ');
    const expression = `(${pageFunction.toString()})(Array.from(document.querySelectorAll(${JSON.stringify(selector)}))${argsJson ? ', ' + argsJson : ''})`;

    const result = await this._session.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      const errorMsg = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`Evaluation failed: ${errorMsg}`);
    }

    return result.result.value as R;
  }

  // === Locator API ===

  /**
   * Create a locator for the given selector.
   */
  locator(selector: string, options?: LocatorOptions): Locator {
    return new Locator(this._page, selector, options);
  }

  /**
   * Locate by test id.
   */
  getByTestId(testId: string | RegExp): Locator {
    return this.locator('*').getByTestId(testId);
  }

  /**
   * Locate by text content.
   */
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator {
    return this.locator('*').getByText(text, options);
  }

  /**
   * Locate by ARIA role.
   */
  getByRole(role: string, options?: ByRoleOptions): Locator {
    return this.locator('*').getByRole(role, options);
  }

  /**
   * Locate by label text.
   */
  getByLabel(text: string | RegExp, options?: { exact?: boolean }): Locator {
    return this.locator('*').getByLabel(text, options);
  }

  /**
   * Locate by placeholder text.
   */
  getByPlaceholder(text: string | RegExp, options?: { exact?: boolean }): Locator {
    return this.locator('*').getByPlaceholder(text, options);
  }

  /**
   * Locate by alt text.
   */
  getByAltText(text: string | RegExp, options?: { exact?: boolean }): Locator {
    return this.locator('*').getByAltText(text, options);
  }

  /**
   * Locate by title attribute.
   */
  getByTitle(text: string | RegExp, options?: { exact?: boolean }): Locator {
    return this.locator('*').getByTitle(text, options);
  }

  /**
   * Wait for selector to appear in the frame.
   */
  async waitForSelector(selector: string, options?: {
    state?: 'attached' | 'detached' | 'visible' | 'hidden';
    timeout?: number;
  }): Promise<ElementHandle | null> {
    const state = options?.state || 'visible';
    const timeout = options?.timeout ?? 30000;
    const startTime = Date.now();

    const checkElement = async (): Promise<ElementHandle | null> => {
      try {
        if (state === 'detached') {
          const exists = await this.evaluate((sel: string) => !!document.querySelector(sel), selector);
          return !exists ? null : await this.$(selector);
        }

        if (state === 'hidden') {
          const visible = await this.evaluate((sel: string) => {
            const el = document.querySelector(sel);
            if (!el) return false;
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          }, selector);
          return !visible ? await this.$(selector) : null;
        }

        if (state === 'attached') {
          return await this.$(selector);
        }

        // state === 'visible'
        const element = await this.$(selector);
        if (!element) return null;

        const visible = await element.isVisible();
        if (visible) return element;

        await element.dispose();
        return null;
      } catch {
        return null;
      }
    };

    while (Date.now() - startTime < timeout) {
      const element = await checkElement();
      if (element !== null)
        return element;
      await new Promise(r => setTimeout(r, 100));
    }

    throw new Error(`Timeout ${timeout}ms exceeded waiting for selector "${selector}" to be ${state}`);
  }
}

/**
 * FrameManager manages the frame tree for a page.
 */
export class FrameManager {
  private _page: CRPage;
  private _frames = new Map<string, Frame>();
  private _mainFrame: Frame | undefined;

  constructor(page: CRPage) {
    this._page = page;
  }

  mainFrame(): Frame | undefined {
    return this._mainFrame;
  }

  frames(): Frame[] {
    return Array.from(this._frames.values());
  }

  frame(frameId: string): Frame | null {
    return this._frames.get(frameId) || null;
  }

  frameAttached(frameId: string, parentFrameId: string | null, session: CRSession): Frame {
    const parentFrame = parentFrameId ? this._frames.get(parentFrameId) || null : null;

    if (!parentFrame) {
      // This is the main frame
      if (this._mainFrame) {
        // Update frame id to retain frame identity
        this._frames.delete(this._mainFrame._id);
        this._mainFrame._id = frameId;
        this._mainFrame._session = session;
        this._frames.set(frameId, this._mainFrame);
        return this._mainFrame;
      } else {
        this._mainFrame = new Frame(this._page, frameId, null, session);
        this._frames.set(frameId, this._mainFrame);
        return this._mainFrame;
      }
    } else {
      // This is a child frame
      const frame = new Frame(this._page, frameId, parentFrame, session);
      this._frames.set(frameId, frame);
      this._page.emit('frameattached', frame);
      return frame;
    }
  }

  frameNavigated(frameId: string, framePayload: Protocol.Page.Frame) {
    const frame = this._frames.get(frameId);
    if (!frame) return;

    frame._updateFromFramePayload(framePayload);
    this._page.emit('framenavigated', frame);
  }

  frameDetached(frameId: string) {
    const frame = this._frames.get(frameId);
    if (!frame) return;

    this._removeFramesRecursively(frame);
    this._page.emit('framedetached', frame);
  }

  private _removeFramesRecursively(frame: Frame) {
    for (const child of frame.childFrames())
      this._removeFramesRecursively(child);
    frame._detach();
    this._frames.delete(frame._id);
  }
}
