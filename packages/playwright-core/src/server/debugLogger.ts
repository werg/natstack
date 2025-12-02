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

/**
 * Simple debug logger for browser environment.
 */
export const debugLogger = {
  isEnabled(name: string): boolean {
    return false;
  },
  log(name: string, message: string | Error): void {
    // In browser context, optionally log to console
    // console.log(`[${name}]`, message);
  },
};

/**
 * Collects recent logs for error reporting.
 */
export class RecentLogsCollector {
  private _logs: string[] = [];
  private _maxLogs = 100;

  log(message: string): void {
    this._logs.push(message);
    if (this._logs.length > this._maxLogs) {
      this._logs.shift();
    }
  }

  recentLogs(): string[] {
    return this._logs.slice();
  }
}
