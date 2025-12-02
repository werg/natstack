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

import { webColors } from '../utils/isomorphic/colors';

import type * as fs from 'fs';
import type * as path from 'path';
import type { Readable, Writable } from 'stream';
import type { Colors } from '@isomorphic/colors';
import type * as channels from '@protocol/channels';

export type Zone = {
  push(data: unknown): Zone;
  pop(): Zone;
  run<R>(func: () => R): R;
  data<T>(): T | undefined;
};

const noopZone: Zone = {
  push: () => noopZone,
  pop: () => noopZone,
  run: func => func(),
  data: () => undefined,
};

export type Platform = {
  name: 'node' | 'web' | 'empty';

  boxedStackPrefixes: () => string[];
  calculateSha1: (text: string) => Promise<string>;
  colors: Colors;
  coreDir?: string;
  createGuid: () => string;
  defaultMaxListeners: () => number;
  env: Record<string, string | undefined>;
  fs: () => typeof fs;
  inspectCustom: symbol | undefined;
  isDebugMode: () => boolean;
  isJSDebuggerAttached: () => boolean;
  isLogEnabled: (name: 'api' | 'channel') => boolean;
  isUnderTest: () => boolean,
  log: (name: 'api' | 'channel', message: string | Error | object) => void;
  path: () => typeof path;
  pathSeparator: string;
  showInternalStackFrames: () => boolean,
  streamFile: (path: string, writable: Writable) => Promise<void>,
  streamReadable: (channel: channels.StreamChannel) => Readable,
  streamWritable: (channel: channels.WritableStreamChannel) => Writable,
  zones: { empty: Zone, current: () => Zone; };
};

export const emptyPlatform: Platform = {
  name: 'empty',

  boxedStackPrefixes: () => [],

  calculateSha1: async () => {
    throw new Error('Not implemented');
  },

  colors: webColors,

  createGuid: () => {
    throw new Error('Not implemented');
  },

  defaultMaxListeners: () => 10,

  env: {},

  fs: () => {
    throw new Error('Not implemented');
  },

  inspectCustom: undefined,

  isDebugMode: () => false,

  isJSDebuggerAttached: () => false,

  isLogEnabled(name: 'api' | 'channel') {
    return false;
  },

  isUnderTest: () => false,

  log(name: 'api' | 'channel', message: string | Error | object) { },

  path: () => {
    throw new Error('Function not implemented.');
  },

  pathSeparator: '/',

  showInternalStackFrames: () => false,

  streamFile(path: string, writable: Writable): Promise<void> {
    throw new Error('Streams are not available');
  },

  streamReadable: (channel: channels.StreamChannel) => {
    throw new Error('Streams are not available');
  },

  streamWritable: (channel: channels.WritableStreamChannel) => {
    throw new Error('Streams are not available');
  },

  zones: { empty: noopZone, current: () => noopZone },
};

function guidFromCrypto(): string {
  const cryptoObj = (globalThis as any).crypto;
  if (!cryptoObj)
    throw new Error('crypto is not available in this environment');
  const bytes = new Uint8Array(16);
  cryptoObj.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

async function sha1FromCrypto(text: string): Promise<string> {
  const cryptoObj = (globalThis as any).crypto;
  if (!cryptoObj)
    throw new Error('crypto is not available in this environment');
  const bytes = new TextEncoder().encode(text);
  const hashBuffer = await cryptoObj.subtle.digest('SHA-1', bytes);
  return Array.from(new Uint8Array(hashBuffer), b => b.toString(16).padStart(2, '0')).join('');
}

export const webPlatform: Platform = {
  ...emptyPlatform,
  name: 'web',
  boxedStackPrefixes: () => [],
  calculateSha1: sha1FromCrypto,
  createGuid: guidFromCrypto,
  colors: webColors,
  defaultMaxListeners: () => 10,
  env: (typeof process !== 'undefined' && process.env) ? process.env as any : {},
  inspectCustom: undefined,
  isDebugMode: () => false,
  isJSDebuggerAttached: () => false,
  isLogEnabled: () => true,
  log: (name: 'api' | 'channel', message: string | Error | object) => {
    if (typeof console !== 'undefined')
      console.debug(name, message);
  },
  pathSeparator: '/',
  path: () => {
    throw new Error('path is not available in web platform');
  },
  fs: () => {
    const injected = (globalThis as any).fs;
    if (!injected)
      throw new Error('fs is not available in this environment');
    return injected as any;
  },
  showInternalStackFrames: () => true,
  streamFile(path: string, writable: Writable): Promise<void> {
    throw new Error('Streams are not available');
  },
  streamReadable: (channel: channels.StreamChannel) => {
    throw new Error('Streams are not available');
  },
  streamWritable: (channel: channels.WritableStreamChannel) => {
    throw new Error('Streams are not available');
  },
  zones: { empty: noopZone, current: () => noopZone },
};
