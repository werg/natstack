/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { CRSession } from './crConnection';
import type { CRPage } from './crBrowser';
import type * as types from '../types';
import type { Protocol } from './protocol';

/**
 * JSHandle represents an in-page JavaScript object.
 */
export class JSHandle<T = unknown> {
  protected _session: CRSession;
  protected _page: CRPage;
  protected _objectId: string;
  protected _disposed = false;
  private _preview: string;

  constructor(page: CRPage, session: CRSession, objectId: string, preview?: string) {
    this._page = page;
    this._session = session;
    this._objectId = objectId;
    this._preview = preview || 'JSHandle@object';
  }

  /**
   * Evaluate a function on this object.
   */
  async evaluate<R>(pageFunction: (arg: T, ...args: unknown[]) => R, ...args: unknown[]): Promise<R> {
    const argsJson = args.map(arg => JSON.stringify(arg)).join(', ');
    const expression = `(function(arg) { return (${pageFunction.toString()})(arg${argsJson ? ', ' + argsJson : ''}); })`;

    const result = await this._session.send('Runtime.callFunctionOn', {
      objectId: this._objectId,
      functionDeclaration: expression,
      arguments: [{ objectId: this._objectId }],
      returnByValue: true,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      const errorMsg = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`Evaluation failed: ${errorMsg}`);
    }

    return result.result.value as R;
  }

  /**
   * Evaluate a function that returns a handle.
   */
  async evaluateHandle<R>(pageFunction: (arg: T, ...args: unknown[]) => R, ...args: unknown[]): Promise<JSHandle<R>> {
    const argsJson = args.map(arg => JSON.stringify(arg)).join(', ');
    const expression = `(function(arg) { return (${pageFunction.toString()})(arg${argsJson ? ', ' + argsJson : ''}); })`;

    const result = await this._session.send('Runtime.callFunctionOn', {
      objectId: this._objectId,
      functionDeclaration: expression,
      arguments: [{ objectId: this._objectId }],
      returnByValue: false,
      awaitPromise: true,
    });

    if (result.exceptionDetails) {
      const errorMsg = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`Evaluation failed: ${errorMsg}`);
    }

    if (!result.result.objectId) {
      // Value was primitive, wrap it
      return new JSHandle<R>(this._page, this._session, '', result.result.description);
    }

    return new JSHandle<R>(this._page, this._session, result.result.objectId, result.result.description);
  }

  /**
   * Get a property of this object as a handle.
   */
  async getProperty(propertyName: string): Promise<JSHandle> {
    const result = await this._session.send('Runtime.callFunctionOn', {
      objectId: this._objectId,
      functionDeclaration: `function(name) { return this[name]; }`,
      arguments: [{ value: propertyName }],
      returnByValue: false,
    });

    if (!result.result.objectId) {
      return new JSHandle(this._page, this._session, '', String(result.result.value));
    }

    return new JSHandle(this._page, this._session, result.result.objectId, result.result.description);
  }

  /**
   * Get all properties of this object.
   */
  async getProperties(): Promise<Map<string, JSHandle>> {
    const response = await this._session.send('Runtime.getProperties', {
      objectId: this._objectId,
      ownProperties: true,
    });

    const result = new Map<string, JSHandle>();
    for (const property of response.result) {
      if (!property.enumerable || !property.value)
        continue;
      const handle = property.value.objectId
        ? new JSHandle(this._page, this._session, property.value.objectId, property.value.description)
        : new JSHandle(this._page, this._session, '', String(property.value.value));
      result.set(property.name, handle);
    }
    return result;
  }

  /**
   * Get the JSON value of this object.
   */
  async jsonValue(): Promise<T> {
    const result = await this._session.send('Runtime.callFunctionOn', {
      objectId: this._objectId,
      functionDeclaration: 'function() { return this; }',
      returnByValue: true,
    });

    return result.result.value as T;
  }

  /**
   * Returns this as an ElementHandle if it's an element.
   */
  asElement(): ElementHandle | null {
    return null;
  }

  /**
   * Dispose of this handle.
   */
  async dispose(): Promise<void> {
    if (this._disposed || !this._objectId)
      return;
    this._disposed = true;
    await this._session.send('Runtime.releaseObject', { objectId: this._objectId }).catch(() => {});
  }

  toString(): string {
    return this._preview;
  }
}

/**
 * ElementHandle represents an in-page DOM element.
 */
export class ElementHandle extends JSHandle<Element> {
  constructor(page: CRPage, session: CRSession, objectId: string, preview?: string) {
    super(page, session, objectId, preview || 'ElementHandle');
  }

  override asElement(): ElementHandle {
    return this;
  }

  /**
   * Get attribute value.
   */
  async getAttribute(name: string): Promise<string | null> {
    return this.evaluate((el, attrName) => el.getAttribute(attrName as string), name);
  }

  /**
   * Get input value.
   */
  async inputValue(): Promise<string> {
    return this.evaluate((el) => (el as HTMLInputElement).value);
  }

  /**
   * Get text content.
   */
  async textContent(): Promise<string | null> {
    return this.evaluate((el) => el.textContent);
  }

  /**
   * Get inner text.
   */
  async innerText(): Promise<string> {
    return this.evaluate((el) => (el as HTMLElement).innerText);
  }

  /**
   * Get inner HTML.
   */
  async innerHTML(): Promise<string> {
    return this.evaluate((el) => el.innerHTML);
  }

  /**
   * Check if element is checked (for checkboxes/radios).
   */
  async isChecked(): Promise<boolean> {
    return this.evaluate((el) => (el as HTMLInputElement).checked);
  }

  /**
   * Check if element is disabled.
   */
  async isDisabled(): Promise<boolean> {
    return this.evaluate((el) => {
      const htmlEl = el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
      return htmlEl.disabled ?? false;
    });
  }

  /**
   * Check if element is editable.
   */
  async isEditable(): Promise<boolean> {
    return this.evaluate((el) => {
      const htmlEl = el as HTMLInputElement;
      return !htmlEl.disabled && !htmlEl.readOnly;
    });
  }

  /**
   * Check if element is enabled.
   */
  async isEnabled(): Promise<boolean> {
    return !(await this.isDisabled());
  }

  /**
   * Check if element is hidden.
   */
  async isHidden(): Promise<boolean> {
    return !(await this.isVisible());
  }

  /**
   * Check if element is visible.
   */
  async isVisible(): Promise<boolean> {
    return this.evaluate((el) => {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0')
        return false;
      const rect = el.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
  }

  /**
   * Dispatch an event on the element.
   */
  async dispatchEvent(type: string, eventInit?: Record<string, unknown>): Promise<void> {
    await this.evaluate((el, args) => {
      const [eventType, init] = args as [string, Record<string, unknown>];
      el.dispatchEvent(new Event(eventType, init as EventInit));
    }, [type, eventInit || {}]);
  }

  /**
   * Scroll element into view if needed.
   */
  async scrollIntoViewIfNeeded(): Promise<void> {
    await this.evaluate((el) => {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    });
  }

  /**
   * Get element's bounding box.
   */
  async boundingBox(): Promise<types.Rect | null> {
    try {
      const result = await this._session.send('DOM.getBoxModel', { objectId: this._objectId });
      if (!result || !result.model)
        return null;

      const quad = result.model.border;
      const x = Math.min(quad[0], quad[2], quad[4], quad[6]);
      const y = Math.min(quad[1], quad[3], quad[5], quad[7]);
      const width = Math.max(quad[0], quad[2], quad[4], quad[6]) - x;
      const height = Math.max(quad[1], quad[3], quad[5], quad[7]) - y;

      return { x, y, width, height };
    } catch {
      return null;
    }
  }

  /**
   * Click the element.
   */
  async click(options?: types.MouseClickOptions): Promise<void> {
    await this.scrollIntoViewIfNeeded();
    const box = await this.boundingBox();
    if (!box)
      throw new Error('Element is not visible');

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this._page.mouse.click(x, y, {
      button: options?.button,
      clickCount: options?.clickCount,
      delay: options?.delay,
    });
  }

  /**
   * Double-click the element.
   */
  async dblclick(options?: { button?: types.MouseButton; delay?: number }): Promise<void> {
    await this.click({ ...options, clickCount: 2 });
  }

  /**
   * Hover over the element.
   */
  async hover(): Promise<void> {
    await this.scrollIntoViewIfNeeded();
    const box = await this.boundingBox();
    if (!box)
      throw new Error('Element is not visible');

    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await this._page.mouse.move(x, y);
  }

  /**
   * Focus the element.
   */
  async focus(): Promise<void> {
    await this.evaluate((el) => (el as HTMLElement).focus());
  }

  /**
   * Type text into the element.
   */
  async type(text: string, options?: { delay?: number }): Promise<void> {
    await this.focus();
    await this._page.keyboard.type(text, options);
  }

  /**
   * Fill the element with text (clears first).
   */
  async fill(value: string): Promise<void> {
    await this.focus();

    // Select all existing content
    await this.evaluate((el) => {
      const input = el as HTMLInputElement;
      if (input.select) {
        input.select();
      } else if (input.setSelectionRange) {
        input.setSelectionRange(0, input.value.length);
      }
    });

    // Insert new value
    await this._page.keyboard.insertText(value);

    // Dispatch events
    await this.evaluate((el) => {
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  /**
   * Press a key on the focused element.
   */
  async press(key: string, options?: { delay?: number }): Promise<void> {
    await this.focus();
    await this._page.keyboard.press(key, options);
  }

  /**
   * Check a checkbox or radio button.
   */
  async check(): Promise<void> {
    const checked = await this.isChecked();
    if (!checked)
      await this.click();
  }

  /**
   * Uncheck a checkbox.
   */
  async uncheck(): Promise<void> {
    const checked = await this.isChecked();
    if (checked)
      await this.click();
  }

  /**
   * Set checked state.
   */
  async setChecked(checked: boolean): Promise<void> {
    if (checked)
      await this.check();
    else
      await this.uncheck();
  }

  /**
   * Take a screenshot of the element.
   */
  async screenshot(options?: { type?: 'png' | 'jpeg'; quality?: number }): Promise<Uint8Array> {
    await this.scrollIntoViewIfNeeded();
    const box = await this.boundingBox();
    if (!box)
      throw new Error('Element is not visible');

    const result = await this._session.send('Page.captureScreenshot', {
      format: options?.type || 'png',
      quality: options?.quality,
      clip: {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        scale: 1,
      },
    });

    // Decode base64 to Uint8Array
    const binaryString = atob(result.data);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Query for a single element within this element.
   */
  async $(selector: string): Promise<ElementHandle | null> {
    const result = await this._session.send('Runtime.callFunctionOn', {
      objectId: this._objectId,
      functionDeclaration: `function(selector) { return this.querySelector(selector); }`,
      arguments: [{ value: selector }],
      returnByValue: false,
    });

    if (!result.result.objectId)
      return null;

    return new ElementHandle(this._page, this._session, result.result.objectId, result.result.description);
  }

  /**
   * Query for all elements within this element.
   */
  async $$(selector: string): Promise<ElementHandle[]> {
    const result = await this._session.send('Runtime.callFunctionOn', {
      objectId: this._objectId,
      functionDeclaration: `function(selector) { return Array.from(this.querySelectorAll(selector)); }`,
      arguments: [{ value: selector }],
      returnByValue: false,
    });

    if (!result.result.objectId)
      return [];

    // Get the array properties to get individual elements
    const arrayHandle = new JSHandle(this._page, this._session, result.result.objectId);
    const properties = await arrayHandle.getProperties();
    await arrayHandle.dispose();

    const elements: ElementHandle[] = [];
    for (const [key, handle] of properties) {
      if (!isNaN(Number(key)) && handle._objectId) {
        elements.push(new ElementHandle(this._page, this._session, handle._objectId));
      }
    }

    return elements;
  }

  /**
   * Wait for an element state.
   */
  async waitForElementState(state: 'visible' | 'hidden' | 'enabled' | 'disabled', options?: { timeout?: number }): Promise<void> {
    const timeout = options?.timeout ?? 30000;
    const startTime = Date.now();

    const checkState = async (): Promise<boolean> => {
      try {
        switch (state) {
          case 'visible':
            return await this.isVisible();
          case 'hidden':
            return await this.isHidden();
          case 'enabled':
            return await this.isEnabled();
          case 'disabled':
            return await this.isDisabled();
          default:
            return false;
        }
      } catch {
        return false;
      }
    };

    while (Date.now() - startTime < timeout) {
      if (await checkState())
        return;
      await new Promise(r => setTimeout(r, 100));
    }

    throw new Error(`Timeout ${timeout}ms exceeded waiting for element to be ${state}`);
  }
}
