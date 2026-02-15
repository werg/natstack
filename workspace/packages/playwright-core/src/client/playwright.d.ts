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
import { Browser } from './browser';
import { BrowserType } from './browserType';
import { ChannelOwner } from './channelOwner';
import { TimeoutError } from './errors';
import { APIRequest } from './fetch';
import { Selectors } from './selectors';
import type * as channels from '@protocol/channels';
import type { BrowserContextOptions, LaunchOptions } from 'playwright-core';
export declare class Playwright extends ChannelOwner<channels.PlaywrightChannel> {
    readonly chromium: BrowserType;
    readonly firefox: BrowserType;
    readonly webkit: BrowserType;
    readonly devices: any;
    selectors: Selectors;
    readonly request: APIRequest;
    readonly errors: {
        TimeoutError: typeof TimeoutError;
    };
    _defaultLaunchOptions?: LaunchOptions;
    _defaultContextOptions?: BrowserContextOptions;
    _defaultContextTimeout?: number;
    _defaultContextNavigationTimeout?: number;
    constructor(parent: ChannelOwner, type: string, guid: string, initializer: channels.PlaywrightInitializer);
    static from(channel: channels.PlaywrightChannel): Playwright;
    private _browserTypes;
    _preLaunchedBrowser(): Browser;
    _allContexts(): import("./browserContext").BrowserContext[];
    _allPages(): import("./page").Page[];
}
//# sourceMappingURL=playwright.d.ts.map