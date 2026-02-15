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

import type { CRPage } from './crBrowser';
import type { ElementHandle } from './crHandle';
import type * as types from '../types';

export interface LocatorOptions {
  hasText?: string | RegExp;
  hasNotText?: string | RegExp;
  has?: Locator;
  hasNot?: Locator;
}

export interface ByRoleOptions {
  checked?: boolean;
  disabled?: boolean;
  exact?: boolean;
  expanded?: boolean;
  includeHidden?: boolean;
  level?: number;
  name?: string | RegExp;
  pressed?: boolean;
  selected?: boolean;
}

/**
 * Locator - represents a way to find element(s) on the page.
 * Locators are lazy - they don't query the page until needed.
 */
export class Locator {
  readonly _page: CRPage;
  readonly _selector: string;

  constructor(page: CRPage, selector: string, options?: LocatorOptions) {
    this._page = page;
    this._selector = selector;

    // Apply filters to selector
    if (options?.hasText) {
      const text = options.hasText;
      if (typeof text === 'string') {
        this._selector += `:has-text("${escapeQuotes(text)}")`;
      } else {
        this._selector += `:has-text(/${text.source}/${text.flags})`;
      }
    }

    if (options?.hasNotText) {
      const text = options.hasNotText;
      if (typeof text === 'string') {
        this._selector += `:not(:has-text("${escapeQuotes(text)}"))`;
      } else {
        this._selector += `:not(:has-text(/${text.source}/${text.flags}))`;
      }
    }
  }

  page(): CRPage {
    return this._page;
  }

  /**
   * Chain to a child locator.
   */
  locator(selector: string, options?: LocatorOptions): Locator {
    return new Locator(this._page, this._selector + ' ' + selector, options);
  }

  /**
   * Filter this locator.
   */
  filter(options?: LocatorOptions): Locator {
    return new Locator(this._page, this._selector, options);
  }

  /**
   * Get the first matching element.
   */
  first(): Locator {
    return new Locator(this._page, this._selector + ':first-child');
  }

  /**
   * Get the last matching element.
   */
  last(): Locator {
    return new Locator(this._page, this._selector + ':last-child');
  }

  /**
   * Get the nth matching element (0-indexed).
   */
  nth(index: number): Locator {
    return new Locator(this._page, this._selector + `:nth-child(${index + 1})`);
  }

  // === getBy* methods ===

  /**
   * Locate by test id attribute.
   */
  getByTestId(testId: string | RegExp): Locator {
    if (typeof testId === 'string') {
      return this.locator(`[data-testid="${escapeQuotes(testId)}"]`);
    }
    // For regex, we'd need to evaluate in page - simplified version
    return this.locator(`[data-testid]`);
  }

  /**
   * Locate by text content.
   */
  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator {
    const exact = options?.exact ?? false;
    if (typeof text === 'string') {
      if (exact) {
        return this.locator(`*:has-text("${escapeQuotes(text)}")`);
      }
      return this.locator(`*:has-text("${escapeQuotes(text)}")`);
    }
    // For regex, use a pseudo-selector approach
    return this.locator(`*`);
  }

  /**
   * Locate by ARIA role.
   */
  getByRole(role: string, options?: ByRoleOptions): Locator {
    let selector = `[role="${role}"]`;

    // Also include implicit roles
    const implicitRoles: Record<string, string> = {
      button: 'button, input[type="button"], input[type="submit"], input[type="reset"]',
      checkbox: 'input[type="checkbox"]',
      link: 'a[href]',
      textbox: 'input:not([type]), input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="tel"], input[type="url"], textarea',
      heading: 'h1, h2, h3, h4, h5, h6',
      img: 'img[alt]',
      list: 'ul, ol',
      listitem: 'li',
      navigation: 'nav',
      main: 'main',
      article: 'article',
      banner: 'header',
      contentinfo: 'footer',
      form: 'form',
      radio: 'input[type="radio"]',
      option: 'option',
      combobox: 'select',
      searchbox: 'input[type="search"]',
      slider: 'input[type="range"]',
      spinbutton: 'input[type="number"]',
      switch: 'input[type="checkbox"][role="switch"]',
      tab: '[role="tab"]',
      tabpanel: '[role="tabpanel"]',
      table: 'table',
      row: 'tr',
      cell: 'td, th',
      dialog: 'dialog, [role="dialog"]',
      alert: '[role="alert"]',
      alertdialog: '[role="alertdialog"]',
      menu: '[role="menu"]',
      menuitem: '[role="menuitem"]',
      menubar: '[role="menubar"]',
      progressbar: 'progress, [role="progressbar"]',
      status: '[role="status"]',
      separator: 'hr, [role="separator"]',
    };

    if (implicitRoles[role]) {
      selector = `${implicitRoles[role]}, [role="${role}"]`;
    }

    if (options?.name) {
      const name = options.name;
      if (typeof name === 'string') {
        // Match by accessible name (aria-label, aria-labelledby, or text content for certain elements)
        selector = `${selector}:is([aria-label="${escapeQuotes(name)}"], [aria-labelledby], :has-text("${escapeQuotes(name)}"))`;
      }
    }

    return this.locator(selector);
  }

  /**
   * Locate by label text.
   */
  getByLabel(text: string | RegExp, options?: { exact?: boolean }): Locator {
    if (typeof text === 'string') {
      // Find input associated with label
      return this.locator(`label:has-text("${escapeQuotes(text)}") + input, label:has-text("${escapeQuotes(text)}") input, [aria-label="${escapeQuotes(text)}"]`);
    }
    return this.locator(`[aria-label]`);
  }

  /**
   * Locate by placeholder text.
   */
  getByPlaceholder(text: string | RegExp, options?: { exact?: boolean }): Locator {
    if (typeof text === 'string') {
      if (options?.exact) {
        return this.locator(`[placeholder="${escapeQuotes(text)}"]`);
      }
      return this.locator(`[placeholder*="${escapeQuotes(text)}"]`);
    }
    return this.locator(`[placeholder]`);
  }

  /**
   * Locate by alt text.
   */
  getByAltText(text: string | RegExp, options?: { exact?: boolean }): Locator {
    if (typeof text === 'string') {
      if (options?.exact) {
        return this.locator(`[alt="${escapeQuotes(text)}"]`);
      }
      return this.locator(`[alt*="${escapeQuotes(text)}"]`);
    }
    return this.locator(`[alt]`);
  }

  /**
   * Locate by title attribute.
   */
  getByTitle(text: string | RegExp, options?: { exact?: boolean }): Locator {
    if (typeof text === 'string') {
      if (options?.exact) {
        return this.locator(`[title="${escapeQuotes(text)}"]`);
      }
      return this.locator(`[title*="${escapeQuotes(text)}"]`);
    }
    return this.locator(`[title]`);
  }

  // === Actions ===

  /**
   * Click the element.
   */
  async click(options?: types.MouseClickOptions): Promise<void> {
    const element = await this._resolveElement();
    try {
      await element.click(options);
    } finally {
      await element.dispose();
    }
  }

  /**
   * Double-click the element.
   */
  async dblclick(options?: { button?: types.MouseButton; delay?: number }): Promise<void> {
    const element = await this._resolveElement();
    try {
      await element.dblclick(options);
    } finally {
      await element.dispose();
    }
  }

  /**
   * Fill the element with text.
   */
  async fill(value: string): Promise<void> {
    const element = await this._resolveElement();
    try {
      await element.fill(value);
    } finally {
      await element.dispose();
    }
  }

  /**
   * Type text into the element.
   */
  async type(text: string, options?: { delay?: number }): Promise<void> {
    const element = await this._resolveElement();
    try {
      await element.type(text, options);
    } finally {
      await element.dispose();
    }
  }

  /**
   * Press a key on the element.
   */
  async press(key: string, options?: { delay?: number }): Promise<void> {
    const element = await this._resolveElement();
    try {
      await element.press(key, options);
    } finally {
      await element.dispose();
    }
  }

  /**
   * Focus the element.
   */
  async focus(): Promise<void> {
    const element = await this._resolveElement();
    try {
      await element.focus();
    } finally {
      await element.dispose();
    }
  }

  /**
   * Hover over the element.
   */
  async hover(): Promise<void> {
    const element = await this._resolveElement();
    try {
      await element.hover();
    } finally {
      await element.dispose();
    }
  }

  /**
   * Check a checkbox/radio.
   */
  async check(): Promise<void> {
    const element = await this._resolveElement();
    try {
      await element.check();
    } finally {
      await element.dispose();
    }
  }

  /**
   * Uncheck a checkbox.
   */
  async uncheck(): Promise<void> {
    const element = await this._resolveElement();
    try {
      await element.uncheck();
    } finally {
      await element.dispose();
    }
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
   * Scroll element into view.
   */
  async scrollIntoViewIfNeeded(): Promise<void> {
    const element = await this._resolveElement();
    try {
      await element.scrollIntoViewIfNeeded();
    } finally {
      await element.dispose();
    }
  }

  /**
   * Take a screenshot of the element.
   */
  async screenshot(options?: { type?: 'png' | 'jpeg'; quality?: number }): Promise<Uint8Array> {
    const element = await this._resolveElement();
    try {
      return await element.screenshot(options);
    } finally {
      await element.dispose();
    }
  }

  // === Queries ===

  /**
   * Get the number of matching elements.
   */
  async count(): Promise<number> {
    return await this._page.evaluate((selector) => {
      return document.querySelectorAll(selector).length;
    }, this._selector);
  }

  /**
   * Get the element handle.
   */
  async elementHandle(options?: { timeout?: number }): Promise<ElementHandle> {
    await this._page.waitForSelector(this._selector, { state: 'attached', ...options });
    const element = await this._page.$(this._selector);
    if (!element)
      throw new Error(`Element not found: ${this._selector}`);
    return element;
  }

  /**
   * Get all element handles.
   */
  async elementHandles(): Promise<ElementHandle[]> {
    return await this._page.$$(this._selector);
  }

  /**
   * Get attribute value.
   */
  async getAttribute(name: string): Promise<string | null> {
    const element = await this._resolveElement();
    try {
      return await element.getAttribute(name);
    } finally {
      await element.dispose();
    }
  }

  /**
   * Get text content.
   */
  async textContent(): Promise<string | null> {
    const element = await this._resolveElement();
    try {
      return await element.textContent();
    } finally {
      await element.dispose();
    }
  }

  /**
   * Get inner text.
   */
  async innerText(): Promise<string> {
    const element = await this._resolveElement();
    try {
      return await element.innerText();
    } finally {
      await element.dispose();
    }
  }

  /**
   * Get inner HTML.
   */
  async innerHTML(): Promise<string> {
    const element = await this._resolveElement();
    try {
      return await element.innerHTML();
    } finally {
      await element.dispose();
    }
  }

  /**
   * Get input value.
   */
  async inputValue(): Promise<string> {
    const element = await this._resolveElement();
    try {
      return await element.inputValue();
    } finally {
      await element.dispose();
    }
  }

  /**
   * Get bounding box.
   */
  async boundingBox(): Promise<types.Rect | null> {
    const element = await this._resolveElement();
    try {
      return await element.boundingBox();
    } finally {
      await element.dispose();
    }
  }

  // === State ===

  /**
   * Check if element is visible.
   */
  async isVisible(): Promise<boolean> {
    try {
      const element = await this._page.$(this._selector);
      if (!element)
        return false;
      try {
        return await element.isVisible();
      } finally {
        await element.dispose();
      }
    } catch {
      return false;
    }
  }

  /**
   * Check if element is hidden.
   */
  async isHidden(): Promise<boolean> {
    return !(await this.isVisible());
  }

  /**
   * Check if element is enabled.
   */
  async isEnabled(): Promise<boolean> {
    const element = await this._resolveElement();
    try {
      return await element.isEnabled();
    } finally {
      await element.dispose();
    }
  }

  /**
   * Check if element is disabled.
   */
  async isDisabled(): Promise<boolean> {
    return !(await this.isEnabled());
  }

  /**
   * Check if element is checked.
   */
  async isChecked(): Promise<boolean> {
    const element = await this._resolveElement();
    try {
      return await element.isChecked();
    } finally {
      await element.dispose();
    }
  }

  /**
   * Check if element is editable.
   */
  async isEditable(): Promise<boolean> {
    const element = await this._resolveElement();
    try {
      return await element.isEditable();
    } finally {
      await element.dispose();
    }
  }

  // === Waiting ===

  /**
   * Wait for the element.
   */
  async waitFor(options?: { state?: 'attached' | 'detached' | 'visible' | 'hidden'; timeout?: number }): Promise<void> {
    await this._page.waitForSelector(this._selector, options);
  }

  // === Bulk operations ===

  /**
   * Get all matching locators.
   */
  async all(): Promise<Locator[]> {
    const count = await this.count();
    return Array.from({ length: count }, (_, i) => this.nth(i));
  }

  /**
   * Get all inner texts.
   */
  async allInnerTexts(): Promise<string[]> {
    return await this._page.$$eval(this._selector, (els) => els.map(e => (e as HTMLElement).innerText));
  }

  /**
   * Get all text contents.
   */
  async allTextContents(): Promise<string[]> {
    return await this._page.$$eval(this._selector, (els) => els.map(e => e.textContent || ''));
  }

  // === Evaluate ===

  /**
   * Evaluate a function on the element.
   */
  async evaluate<R>(pageFunction: (el: Element, ...args: unknown[]) => R, ...args: unknown[]): Promise<R> {
    const element = await this._resolveElement();
    try {
      return await element.evaluate(pageFunction as (arg: Element, ...args: unknown[]) => R, ...args);
    } finally {
      await element.dispose();
    }
  }

  /**
   * Evaluate a function on all matching elements.
   */
  async evaluateAll<R>(pageFunction: (els: Element[], ...args: unknown[]) => R, ...args: unknown[]): Promise<R> {
    return await this._page.$$eval(this._selector, pageFunction, ...args);
  }

  // === Internal ===

  private async _resolveElement(): Promise<ElementHandle> {
    const element = await this._page.$(this._selector);
    if (!element)
      throw new Error(`Element not found: ${this._selector}`);
    return element;
  }

  toString(): string {
    return `Locator@${this._selector}`;
  }
}

// Helper function to escape quotes in strings
function escapeQuotes(str: string): string {
  return str.replace(/"/g, '\\"');
}
