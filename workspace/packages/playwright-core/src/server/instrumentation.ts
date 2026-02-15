/**
 * Copyright (c) Microsoft Corporation. All rights reserved.
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

import type { Browser } from './browser';
import type { BrowserContext } from './browserContext';
import type { BrowserType } from './browserType';
import type { Dialog } from './dialog';
import type { Download } from './download';
import type { APIRequestContext } from './fetch';
import type { Frame } from './frames';
import type { Page } from './page';
import type { Playwright } from './playwright';
import type { CallMetadata } from '@protocol/callMetadata';
export type { CallMetadata } from '@protocol/callMetadata';
import type { LogName } from './utils/debugLogger';

export type Attribution = {
  playwright: Playwright;
  browserType?: BrowserType;
  browser?: Browser;
  context?: BrowserContext | APIRequestContext;
  page?: Page;
  frame?: Frame;
};

function generateGuid(): string {
  const cryptoObj = (globalThis as any).crypto;
  if (cryptoObj?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoObj.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }
  return 'xxxxxxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16));
}

type Listener = (...args: any[]) => void;

class BasicEventEmitter {
  private _listeners = new Map<string | symbol, Set<Listener>>();
  private _maxListeners = 10;

  on(event: string | symbol, listener: Listener) {
    return this.addListener(event, listener);
  }

  addListener(event: string | symbol, listener: Listener) {
    let set = this._listeners.get(event);
    if (!set) {
      set = new Set();
      this._listeners.set(event, set);
    }
    set.add(listener);
    return this;
  }

  once(event: string | symbol, listener: Listener) {
    const wrapper: Listener = (...args: any[]) => {
      this.removeListener(event, wrapper);
      listener(...args);
    };
    return this.addListener(event, wrapper);
  }

  off(event: string | symbol, listener: Listener) {
    return this.removeListener(event, listener);
  }

  removeListener(event: string | symbol, listener: Listener) {
    const set = this._listeners.get(event);
    if (!set)
      return this;
    set.delete(listener);
    if (!set.size)
      this._listeners.delete(event);
    return this;
  }

  removeAllListeners(event?: string | symbol) {
    if (event === undefined)
      this._listeners.clear();
    else
      this._listeners.delete(event);
    return this;
  }

  emit(event: string | symbol, ...args: any[]) {
    const set = this._listeners.get(event);
    if (!set)
      return false;
    for (const listener of Array.from(set))
      listener(...args);
    return true;
  }

  setMaxListeners(n: number) {
    this._maxListeners = n;
    return this;
  }

  listenerCount(event: string | symbol) {
    return this._listeners.get(event)?.size || 0;
  }
}

export class SdkObject extends BasicEventEmitter {
  guid: string;
  attribution: Attribution;
  instrumentation: Instrumentation;
  logName?: LogName;

  constructor(parent: SdkObject, guidPrefix?: string, guid?: string) {
    super();
    this.guid = guid || `${guidPrefix || ''}@${generateGuid()}`;
    this.setMaxListeners(0);
    this.attribution = { ...parent.attribution };
    this.instrumentation = parent.instrumentation;
  }
}

export function createRootSdkObject() {
  const fakeParent = { attribution: {}, instrumentation: createInstrumentation() };
  const root = new SdkObject(fakeParent as any);
  root.guid = '';
  return root;
}

export interface Instrumentation {
  addListener(listener: InstrumentationListener, context: BrowserContext | APIRequestContext | null): void;
  removeListener(listener: InstrumentationListener): void;
  onBeforeCall(sdkObject: SdkObject, metadata: CallMetadata): Promise<void>;
  onBeforeInputAction(sdkObject: SdkObject, metadata: CallMetadata): Promise<void>;
  onCallLog(sdkObject: SdkObject, metadata: CallMetadata, logName: string, message: string): void;
  onAfterCall(sdkObject: SdkObject, metadata: CallMetadata): Promise<void>;
  onPageOpen(page: Page): void;
  onPageClose(page: Page): void;
  onBrowserOpen(browser: Browser): void;
  onBrowserClose(browser: Browser): void;
  onDialog(dialog: Dialog): void;
  onDownload(page: Page, download: Download): void;
}

export interface InstrumentationListener {
  onBeforeCall?(sdkObject: SdkObject, metadata: CallMetadata): Promise<void>;
  onBeforeInputAction?(sdkObject: SdkObject, metadata: CallMetadata): Promise<void>;
  onCallLog?(sdkObject: SdkObject, metadata: CallMetadata, logName: string, message: string): void;
  onAfterCall?(sdkObject: SdkObject, metadata: CallMetadata): Promise<void>;
  onPageOpen?(page: Page): void;
  onPageClose?(page: Page): void;
  onBrowserOpen?(browser: Browser): void;
  onBrowserClose?(browser: Browser): void;
  onDialog?(dialog: Dialog): void;
  onDownload?(page: Page, download: Download): void;
}

export function createInstrumentation(): Instrumentation {
  const listeners = new Map<InstrumentationListener, BrowserContext | APIRequestContext | null>();
  return new Proxy({}, {
    get: (obj: any, prop: string | symbol) => {
      if (typeof prop !== 'string')
        return obj[prop];
      if (prop === 'addListener')
        return (listener: InstrumentationListener, context: BrowserContext | APIRequestContext | null) => listeners.set(listener, context);
      if (prop === 'removeListener')
        return (listener: InstrumentationListener) => listeners.delete(listener);
      if (!prop.startsWith('on'))
        return obj[prop];
      return async (sdkObject: SdkObject, ...params: any[]) => {
        for (const [listener, context] of listeners) {
          if (!context || sdkObject.attribution.context === context)
            await (listener as any)[prop]?.(sdkObject, ...params);
        }
      };
    },
  });
}
