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
export class Playwright extends ChannelOwner {
    constructor(parent, type, guid, initializer) {
        super(parent, type, guid, initializer);
        this.request = new APIRequest(this);
        this.chromium = BrowserType.from(initializer.chromium);
        this.chromium._playwright = this;
        this.firefox = BrowserType.from(initializer.firefox);
        this.firefox._playwright = this;
        this.webkit = BrowserType.from(initializer.webkit);
        this.webkit._playwright = this;
        this.devices = this._connection.localUtils()?.devices ?? {};
        this.selectors = new Selectors(this._connection._platform);
        this.errors = { TimeoutError };
    }
    static from(channel) {
        return channel._object;
    }
    _browserTypes() {
        return [this.chromium, this.firefox, this.webkit];
    }
    _preLaunchedBrowser() {
        const browser = Browser.from(this._initializer.preLaunchedBrowser);
        browser._connectToBrowserType(this[browser._name], {}, undefined);
        return browser;
    }
    _allContexts() {
        return this._browserTypes().flatMap(type => [...type._contexts]);
    }
    _allPages() {
        return this._allContexts().flatMap(context => context.pages());
    }
}
//# sourceMappingURL=playwright.js.map