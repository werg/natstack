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

import type { CRPage } from './crBrowser';
import type { CRSession } from './crConnection';

export type DialogType = 'alert' | 'beforeunload' | 'confirm' | 'prompt';

/**
 * Dialog represents a JavaScript dialog (alert, confirm, prompt, beforeunload).
 */
export class Dialog {
  private _page: CRPage;
  private _session: CRSession;
  private _type: DialogType;
  private _message: string;
  private _defaultValue: string;
  private _handled = false;

  constructor(page: CRPage, session: CRSession, type: DialogType, message: string, defaultValue?: string) {
    this._page = page;
    this._session = session;
    this._type = type;
    this._message = message;
    this._defaultValue = defaultValue || '';
  }

  /**
   * Returns the page that triggered this dialog.
   */
  page(): CRPage {
    return this._page;
  }

  /**
   * Returns the type of the dialog (alert, confirm, prompt, beforeunload).
   */
  type(): DialogType {
    return this._type;
  }

  /**
   * Returns the message displayed in the dialog.
   */
  message(): string {
    return this._message;
  }

  /**
   * Returns the default value for prompt dialogs.
   */
  defaultValue(): string {
    return this._defaultValue;
  }

  /**
   * Accept the dialog. For prompt dialogs, optionally provide a value.
   */
  async accept(promptText?: string): Promise<void> {
    if (this._handled)
      throw new Error('Cannot accept dialog which is already handled!');
    this._handled = true;
    await this._session.send('Page.handleJavaScriptDialog', {
      accept: true,
      promptText: promptText ?? this._defaultValue,
    });
  }

  /**
   * Dismiss the dialog.
   */
  async dismiss(): Promise<void> {
    if (this._handled)
      throw new Error('Cannot dismiss dialog which is already handled!');
    this._handled = true;
    await this._session.send('Page.handleJavaScriptDialog', {
      accept: false,
    });
  }

  /**
   * Close the dialog with default action (accept for beforeunload, dismiss otherwise).
   */
  async close(): Promise<void> {
    if (this._type === 'beforeunload')
      await this.accept();
    else
      await this.dismiss();
  }
}
