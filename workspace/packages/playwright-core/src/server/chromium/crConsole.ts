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
import type { JSHandle } from './crHandle';
import type * as types from '../types';

/**
 * Console message type (matches Runtime.consoleAPICalled type).
 */
export type ConsoleMessageType =
  | 'log'
  | 'debug'
  | 'info'
  | 'error'
  | 'warning'
  | 'dir'
  | 'dirxml'
  | 'table'
  | 'trace'
  | 'clear'
  | 'startGroup'
  | 'startGroupCollapsed'
  | 'endGroup'
  | 'assert'
  | 'profile'
  | 'profileEnd'
  | 'count'
  | 'timeEnd';

/**
 * ConsoleMessage represents a console message from the browser.
 */
export class ConsoleMessage {
  private _page: CRPage;
  private _type: ConsoleMessageType;
  private _text?: string;
  private _args: JSHandle[];
  private _location: types.ConsoleMessageLocation;

  constructor(
    page: CRPage,
    type: ConsoleMessageType,
    text: string | undefined,
    args: JSHandle[],
    location?: types.ConsoleMessageLocation
  ) {
    this._page = page;
    this._type = type;
    this._text = text;
    this._args = args;
    this._location = location || { url: '', lineNumber: 0, columnNumber: 0 };
  }

  /**
   * Returns the page that emitted this console message.
   */
  page(): CRPage {
    return this._page;
  }

  /**
   * Returns the type of console message (log, debug, info, error, warning, etc.).
   */
  type(): ConsoleMessageType {
    return this._type;
  }

  /**
   * Returns the text of the console message.
   */
  text(): string {
    if (this._text === undefined) {
      // Generate text from args
      this._text = this._args.map(arg => arg.toString()).join(' ');
    }
    return this._text;
  }

  /**
   * Returns the arguments passed to the console call as JSHandle objects.
   */
  args(): JSHandle[] {
    return this._args;
  }

  /**
   * Returns the location in the source code where the console call was made.
   */
  location(): types.ConsoleMessageLocation {
    return this._location;
  }
}
