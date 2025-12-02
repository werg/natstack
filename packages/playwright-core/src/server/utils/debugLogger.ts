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

const debugLoggerColorMap = {
  'api': 45, // cyan
  'protocol': 34, // green
  'install': 34, // green
  'download': 34, // green
  'browser': 0, // reset
  'socks': 92, // purple
  'client-certificates': 92, // purple
  'error': 160, // red,
  'channel': 33, // blue
  'server': 45, // cyan
  'server:channel': 34, // green
  'server:metadata': 33, // blue,
  'recorder': 45, // cyan
};
export type LogName = keyof typeof debugLoggerColorMap;

const isNode = typeof process !== 'undefined' && !!(process.versions?.node);

class DebugLogger {
  log(name: LogName, message: string | Error | object) {
    // Browser builds keep logging minimal to avoid pulling node polyfills.
    if (!isNode) {
      if (typeof console !== 'undefined')
        console.debug(`[pw:${name}]`, message);
      return;
    }
    if (typeof console !== 'undefined')
      console.debug(`[pw:${name}]`, message);
  }

  isEnabled(name: LogName) {
    return isNode ? true : false;
  }
}

export const debugLogger = new DebugLogger();

const kLogCount = 150;
export class RecentLogsCollector {
  private _logs: string[] = [];
  private _listeners: ((log: string) => void)[] = [];

  log(message: string) {
    this._logs.push(message);
    if (this._logs.length === kLogCount * 2)
      this._logs.splice(0, kLogCount);
    for (const listener of this._listeners)
      listener(message);
  }

  recentLogs(): string[] {
    if (this._logs.length > kLogCount)
      return this._logs.slice(-kLogCount);
    return this._logs;
  }

  onMessage(listener: (message: string) => void) {
    for (const message of this._logs)
      listener(message);
    this._listeners.push(listener);
  }
}
