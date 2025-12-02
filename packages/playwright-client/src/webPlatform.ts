/* eslint-disable no-console */
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

// Web platform implementation for browser context
// This is a minimal implementation that overrides the emptyPlatform with browser-specific capabilities
export const webPlatform = {
  name: 'web',

  boxedStackPrefixes: () => [],

  calculateSha1: async (text: string) => {
    const bytes = new TextEncoder().encode(text);
    const hashBuffer = await window.crypto.subtle.digest('SHA-1', bytes);
    return Array.from(new Uint8Array(hashBuffer), b => b.toString(16).padStart(2, '0')).join('');
  },

  createGuid: () => {
    return Array.from(window.crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
  },

  isLogEnabled(name: 'api' | 'channel') {
    return true;
  },

  log(name: 'api' | 'channel', message: string | Error | object) {
    console.debug(name, message);
  },

  showInternalStackFrames: () => true,

  // Additional properties required by Platform type (minimal stubs)
  pathSeparator: '/',
  env: {},
  colors: { reset: '', bold: '', dim: '', italic: '' } as any,
  zones: {
    empty: { push: (d: unknown) => null as any, pop: () => null as any, run: (f: any) => f(), data: () => undefined },
    current: () => ({ push: (d: unknown) => null as any, pop: () => null as any, run: (f: any) => f(), data: () => undefined })
  }
};
