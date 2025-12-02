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
import { Artifact } from './artifact';
import { CDPSession } from './cdpSession';
import { ChannelOwner } from './channelOwner';
import { evaluationScript } from './clientHelper';
import { Clock } from './clock';
import { ConsoleMessage } from './consoleMessage';
import { Dialog } from './dialog';
import { TargetClosedError, parseError } from './errors';
import { Events } from './events';
import { APIRequestContext } from './fetch';
import { Frame } from './frame';
import { HarRouter } from './harRouter';
import * as network from './network';
import { BindingCall, Page } from './page';
import { Tracing } from './tracing';
import { Waiter } from './waiter';
import { WebError } from './webError';
import { Worker } from './worker';
import { TimeoutSettings } from './timeoutSettings';
import { mkdirIfNeeded } from './fileUtils';
import { headersObjectToArray } from '../utils/isomorphic/headers';
import { urlMatchesEqual } from '../utils/isomorphic/urlMatch';
import { isRegExp, isString } from '../utils/isomorphic/rtti';
import { rewriteErrorMessage } from '../utils/isomorphic/stackTrace';
export class BrowserContext extends ChannelOwner {
    static from(context) {
        return context._object;
    }
    static fromNullable(context) {
        return context ? BrowserContext.from(context) : null;
    }
    constructor(parent, type, guid, initializer) {
        super(parent, type, guid, initializer);
        this._pages = new Set();
        this._routes = [];
        this._webSocketRoutes = [];
        // Browser is null for browser contexts created outside of normal browser, e.g. android or electron.
        this._browser = null;
        this._bindings = new Map();
        this._forReuse = false;
        this._serviceWorkers = new Set();
        this._harRecorders = new Map();
        this._closingStatus = 'none';
        this._harRouters = [];
        this._options = initializer.options;
        this._timeoutSettings = new TimeoutSettings(this._platform);
        this.tracing = Tracing.from(initializer.tracing);
        this.request = APIRequestContext.from(initializer.requestContext);
        this.request._timeoutSettings = this._timeoutSettings;
        this.clock = new Clock(this);
        this._channel.on('bindingCall', ({ binding }) => this._onBinding(BindingCall.from(binding)));
        this._channel.on('close', () => this._onClose());
        this._channel.on('page', ({ page }) => this._onPage(Page.from(page)));
        this._channel.on('route', ({ route }) => this._onRoute(network.Route.from(route)));
        this._channel.on('webSocketRoute', ({ webSocketRoute }) => this._onWebSocketRoute(network.WebSocketRoute.from(webSocketRoute)));
        this._channel.on('serviceWorker', ({ worker }) => {
            const serviceWorker = Worker.from(worker);
            serviceWorker._context = this;
            this._serviceWorkers.add(serviceWorker);
            this.emit(Events.BrowserContext.ServiceWorker, serviceWorker);
        });
        this._channel.on('console', event => {
            const worker = Worker.fromNullable(event.worker);
            const page = Page.fromNullable(event.page);
            const consoleMessage = new ConsoleMessage(this._platform, event, page, worker);
            worker?.emit(Events.Worker.Console, consoleMessage);
            page?.emit(Events.Page.Console, consoleMessage);
            if (worker && this._serviceWorkers.has(worker)) {
                const scope = this._serviceWorkerScope(worker);
                for (const page of this._pages) {
                    if (scope && page.url().startsWith(scope))
                        page.emit(Events.Page.Console, consoleMessage);
                }
            }
            this.emit(Events.BrowserContext.Console, consoleMessage);
        });
        this._channel.on('pageError', ({ error, page }) => {
            const pageObject = Page.from(page);
            const parsedError = parseError(error);
            this.emit(Events.BrowserContext.WebError, new WebError(pageObject, parsedError));
            if (pageObject)
                pageObject.emit(Events.Page.PageError, parsedError);
        });
        this._channel.on('dialog', ({ dialog }) => {
            const dialogObject = Dialog.from(dialog);
            let hasListeners = this.emit(Events.BrowserContext.Dialog, dialogObject);
            const page = dialogObject.page();
            if (page)
                hasListeners = page.emit(Events.Page.Dialog, dialogObject) || hasListeners;
            if (!hasListeners) {
                // Although we do similar handling on the server side, we still need this logic
                // on the client side due to a possible race condition between two async calls:
                // a) removing "dialog" listener subscription (client->server)
                // b) actual "dialog" event (server->client)
                if (dialogObject.type() === 'beforeunload')
                    dialog.accept({}).catch(() => { });
                else
                    dialog.dismiss().catch(() => { });
            }
        });
        this._channel.on('request', ({ request, page }) => this._onRequest(network.Request.from(request), Page.fromNullable(page)));
        this._channel.on('requestFailed', ({ request, failureText, responseEndTiming, page }) => this._onRequestFailed(network.Request.from(request), responseEndTiming, failureText, Page.fromNullable(page)));
        this._channel.on('requestFinished', params => this._onRequestFinished(params));
        this._channel.on('response', ({ response, page }) => this._onResponse(network.Response.from(response), Page.fromNullable(page)));
        // Recorder event handling removed - not supported in browser client
        this._closedPromise = new Promise(f => this.once(Events.BrowserContext.Close, f));
        this._setEventToSubscriptionMapping(new Map([
            [Events.BrowserContext.Console, 'console'],
            [Events.BrowserContext.Dialog, 'dialog'],
            [Events.BrowserContext.Request, 'request'],
            [Events.BrowserContext.Response, 'response'],
            [Events.BrowserContext.RequestFinished, 'requestFinished'],
            [Events.BrowserContext.RequestFailed, 'requestFailed'],
        ]));
    }
    async _initializeHarFromOptions(recordHar) {
        if (!recordHar)
            return;
        const defaultContent = recordHar.path.endsWith('.zip') ? 'attach' : 'embed';
        await this._recordIntoHAR(recordHar.path, null, {
            url: recordHar.urlFilter,
            updateContent: recordHar.content ?? (recordHar.omitContent ? 'omit' : defaultContent),
            updateMode: recordHar.mode ?? 'full',
        });
    }
    _onPage(page) {
        this._pages.add(page);
        this.emit(Events.BrowserContext.Page, page);
        if (page._opener && !page._opener.isClosed())
            page._opener.emit(Events.Page.Popup, page);
    }
    _onRequest(request, page) {
        this.emit(Events.BrowserContext.Request, request);
        if (page)
            page.emit(Events.Page.Request, request);
    }
    _onResponse(response, page) {
        this.emit(Events.BrowserContext.Response, response);
        if (page)
            page.emit(Events.Page.Response, response);
    }
    _onRequestFailed(request, responseEndTiming, failureText, page) {
        request._failureText = failureText || null;
        request._setResponseEndTiming(responseEndTiming);
        this.emit(Events.BrowserContext.RequestFailed, request);
        if (page)
            page.emit(Events.Page.RequestFailed, request);
    }
    _onRequestFinished(params) {
        const { responseEndTiming } = params;
        const request = network.Request.from(params.request);
        const response = network.Response.fromNullable(params.response);
        const page = Page.fromNullable(params.page);
        request._setResponseEndTiming(responseEndTiming);
        this.emit(Events.BrowserContext.RequestFinished, request);
        if (page)
            page.emit(Events.Page.RequestFinished, request);
        if (response)
            response._finishedPromise.resolve(null);
    }
    async _onRoute(route) {
        route._context = this;
        const page = route.request()._safePage();
        const routeHandlers = this._routes.slice();
        for (const routeHandler of routeHandlers) {
            // If the page or the context was closed we stall all requests right away.
            if (page?._closeWasCalled || this._closingStatus !== 'none')
                return;
            if (!routeHandler.matches(route.request().url()))
                continue;
            const index = this._routes.indexOf(routeHandler);
            if (index === -1)
                continue;
            if (routeHandler.willExpire())
                this._routes.splice(index, 1);
            const handled = await routeHandler.handle(route);
            if (!this._routes.length)
                this._updateInterceptionPatterns({ internal: true }).catch(() => { });
            if (handled)
                return;
        }
        // If the page is closed or unrouteAll() was called without waiting and interception disabled,
        // the method will throw an error - silence it.
        await route._innerContinue(true /* isFallback */).catch(() => { });
    }
    async _onWebSocketRoute(webSocketRoute) {
        const routeHandler = this._webSocketRoutes.find(route => route.matches(webSocketRoute.url()));
        if (routeHandler)
            await routeHandler.handle(webSocketRoute);
        else
            webSocketRoute.connectToServer();
    }
    async _onBinding(bindingCall) {
        const func = this._bindings.get(bindingCall._initializer.name);
        if (!func)
            return;
        await bindingCall.call(func);
    }
    _serviceWorkerScope(serviceWorker) {
        try {
            let url = new URL('.', serviceWorker.url()).href;
            if (!url.endsWith('/'))
                url += '/';
            return url;
        }
        catch {
            return null;
        }
    }
    setDefaultNavigationTimeout(timeout) {
        this._timeoutSettings.setDefaultNavigationTimeout(timeout);
    }
    setDefaultTimeout(timeout) {
        this._timeoutSettings.setDefaultTimeout(timeout);
    }
    browser() {
        return this._browser;
    }
    pages() {
        return [...this._pages];
    }
    async newPage() {
        if (this._ownerPage)
            throw new Error('Please use browser.newContext()');
        return Page.from((await this._channel.newPage()).page);
    }
    async cookies(urls) {
        if (!urls)
            urls = [];
        if (urls && typeof urls === 'string')
            urls = [urls];
        return (await this._channel.cookies({ urls: urls })).cookies;
    }
    async addCookies(cookies) {
        await this._channel.addCookies({ cookies });
    }
    async clearCookies(options = {}) {
        await this._channel.clearCookies({
            name: isString(options.name) ? options.name : undefined,
            nameRegexSource: isRegExp(options.name) ? options.name.source : undefined,
            nameRegexFlags: isRegExp(options.name) ? options.name.flags : undefined,
            domain: isString(options.domain) ? options.domain : undefined,
            domainRegexSource: isRegExp(options.domain) ? options.domain.source : undefined,
            domainRegexFlags: isRegExp(options.domain) ? options.domain.flags : undefined,
            path: isString(options.path) ? options.path : undefined,
            pathRegexSource: isRegExp(options.path) ? options.path.source : undefined,
            pathRegexFlags: isRegExp(options.path) ? options.path.flags : undefined,
        });
    }
    async grantPermissions(permissions, options) {
        await this._channel.grantPermissions({ permissions, ...options });
    }
    async clearPermissions() {
        await this._channel.clearPermissions();
    }
    async setGeolocation(geolocation) {
        await this._channel.setGeolocation({ geolocation: geolocation || undefined });
    }
    async setExtraHTTPHeaders(headers) {
        network.validateHeaders(headers);
        await this._channel.setExtraHTTPHeaders({ headers: headersObjectToArray(headers) });
    }
    async setOffline(offline) {
        await this._channel.setOffline({ offline });
    }
    async setHTTPCredentials(httpCredentials) {
        await this._channel.setHTTPCredentials({ httpCredentials: httpCredentials || undefined });
    }
    async addInitScript(script, arg) {
        const source = await evaluationScript(this._platform, script, arg);
        await this._channel.addInitScript({ source });
    }
    async exposeBinding(name, callback, options = {}) {
        await this._channel.exposeBinding({ name, needsHandle: options.handle });
        this._bindings.set(name, callback);
    }
    async exposeFunction(name, callback) {
        await this._channel.exposeBinding({ name });
        const binding = (source, ...args) => callback(...args);
        this._bindings.set(name, binding);
    }
    async route(url, handler, options = {}) {
        this._routes.unshift(new network.RouteHandler(this._platform, this._options.baseURL, url, handler, options.times));
        await this._updateInterceptionPatterns({ title: 'Route requests' });
    }
    async routeWebSocket(url, handler) {
        this._webSocketRoutes.unshift(new network.WebSocketRouteHandler(this._options.baseURL, url, handler));
        await this._updateWebSocketInterceptionPatterns({ title: 'Route WebSockets' });
    }
    async _recordIntoHAR(har, page, options = {}) {
        const { harId } = await this._channel.harStart({
            page: page?._channel,
            options: {
                zip: har.endsWith('.zip'),
                content: options.updateContent ?? 'attach',
                urlGlob: isString(options.url) ? options.url : undefined,
                urlRegexSource: isRegExp(options.url) ? options.url.source : undefined,
                urlRegexFlags: isRegExp(options.url) ? options.url.flags : undefined,
                mode: options.updateMode ?? 'minimal',
            },
        });
        this._harRecorders.set(harId, { path: har, content: options.updateContent ?? 'attach' });
    }
    async routeFromHAR(har, options = {}) {
        const localUtils = this._connection.localUtils();
        if (!localUtils)
            throw new Error('Route from har is not supported in thin clients');
        if (options.update) {
            await this._recordIntoHAR(har, null, options);
            return;
        }
        const harRouter = await HarRouter.create(localUtils, har, options.notFound || 'abort', { urlMatch: options.url });
        this._harRouters.push(harRouter);
        await harRouter.addContextRoute(this);
    }
    _disposeHarRouters() {
        this._harRouters.forEach(router => router.dispose());
        this._harRouters = [];
    }
    async unrouteAll(options) {
        await this._unrouteInternal(this._routes, [], options?.behavior);
        this._disposeHarRouters();
    }
    async unroute(url, handler) {
        const removed = [];
        const remaining = [];
        for (const route of this._routes) {
            if (urlMatchesEqual(route.url, url) && (!handler || route.handler === handler))
                removed.push(route);
            else
                remaining.push(route);
        }
        await this._unrouteInternal(removed, remaining, 'default');
    }
    async _unrouteInternal(removed, remaining, behavior) {
        this._routes = remaining;
        if (behavior && behavior !== 'default') {
            const promises = removed.map(routeHandler => routeHandler.stop(behavior));
            await Promise.all(promises);
        }
        await this._updateInterceptionPatterns({ title: 'Unroute requests' });
    }
    async _updateInterceptionPatterns(options) {
        const patterns = network.RouteHandler.prepareInterceptionPatterns(this._routes);
        await this._wrapApiCall(() => this._channel.setNetworkInterceptionPatterns({ patterns }), options);
    }
    async _updateWebSocketInterceptionPatterns(options) {
        const patterns = network.WebSocketRouteHandler.prepareInterceptionPatterns(this._webSocketRoutes);
        await this._wrapApiCall(() => this._channel.setWebSocketInterceptionPatterns({ patterns }), options);
    }
    _effectiveCloseReason() {
        return this._closeReason || this._browser?._closeReason;
    }
    async waitForEvent(event, optionsOrPredicate = {}) {
        return await this._wrapApiCall(async () => {
            const timeout = this._timeoutSettings.timeout(typeof optionsOrPredicate === 'function' ? {} : optionsOrPredicate);
            const predicate = typeof optionsOrPredicate === 'function' ? optionsOrPredicate : optionsOrPredicate.predicate;
            const waiter = Waiter.createForEvent(this, event);
            waiter.rejectOnTimeout(timeout, `Timeout ${timeout}ms exceeded while waiting for event "${event}"`);
            if (event !== Events.BrowserContext.Close)
                waiter.rejectOnEvent(this, Events.BrowserContext.Close, () => new TargetClosedError(this._effectiveCloseReason()));
            const result = await waiter.waitForEvent(this, event, predicate);
            waiter.dispose();
            return result;
        });
    }
    async storageState(options = {}) {
        const state = await this._channel.storageState({ indexedDB: options.indexedDB });
        if (options.path) {
            await mkdirIfNeeded(this._platform, options.path);
            await this._platform.fs().promises.writeFile(options.path, JSON.stringify(state, undefined, 2), 'utf8');
        }
        return state;
    }
    backgroundPages() {
        return [];
    }
    serviceWorkers() {
        return [...this._serviceWorkers];
    }
    async newCDPSession(page) {
        // channelOwner.ts's validation messages don't handle the pseudo-union type, so we're explicit here
        if (!(page instanceof Page) && !(page instanceof Frame))
            throw new Error('page: expected Page or Frame');
        const result = await this._channel.newCDPSession(page instanceof Page ? { page: page._channel } : { frame: page._channel });
        return CDPSession.from(result.session);
    }
    _onClose() {
        this._closingStatus = 'closed';
        this._browser?._contexts.delete(this);
        this._browser?._browserType._contexts.delete(this);
        this._browser?._browserType._playwright.selectors._contextsForSelectors.delete(this);
        this._disposeHarRouters();
        this.tracing._resetStackCounter();
        this.emit(Events.BrowserContext.Close, this);
    }
    async [Symbol.asyncDispose]() {
        await this.close();
    }
    async close(options = {}) {
        if (this._closingStatus !== 'none')
            return;
        this._closeReason = options.reason;
        this._closingStatus = 'closing';
        await this.request.dispose(options);
        await this._instrumentation.runBeforeCloseBrowserContext(this);
        await this._wrapApiCall(async () => {
            for (const [harId, harParams] of this._harRecorders) {
                const har = await this._channel.harExport({ harId });
                const artifact = Artifact.from(har.artifact);
                // Server side will compress artifact if content is attach or if file is .zip.
                const isCompressed = harParams.content === 'attach' || harParams.path.endsWith('.zip');
                const needCompressed = harParams.path.endsWith('.zip');
                if (isCompressed && !needCompressed) {
                    const localUtils = this._connection.localUtils();
                    if (!localUtils)
                        throw new Error('Uncompressed har is not supported in thin clients');
                    await artifact.saveAs(harParams.path + '.tmp');
                    await localUtils.harUnzip({ zipFile: harParams.path + '.tmp', harFile: harParams.path });
                }
                else {
                    await artifact.saveAs(harParams.path);
                }
                await artifact.delete();
            }
        }, { internal: true });
        await this._channel.close(options);
        await this._closedPromise;
    }
}
async function prepareStorageState(platform, storageState) {
    if (typeof storageState !== 'string')
        return storageState;
    try {
        return JSON.parse(await platform.fs().promises.readFile(storageState, 'utf8'));
    }
    catch (e) {
        rewriteErrorMessage(e, `Error reading storage state from ${storageState}:\n` + e.message);
        throw e;
    }
}
export async function prepareBrowserContextParams(platform, options) {
    if (options.videoSize && !options.videosPath)
        throw new Error(`"videoSize" option requires "videosPath" to be specified`);
    if (options.extraHTTPHeaders)
        network.validateHeaders(options.extraHTTPHeaders);
    const contextParams = {
        ...options,
        viewport: options.viewport === null ? undefined : options.viewport,
        noDefaultViewport: options.viewport === null,
        extraHTTPHeaders: options.extraHTTPHeaders ? headersObjectToArray(options.extraHTTPHeaders) : undefined,
        storageState: options.storageState ? await prepareStorageState(platform, options.storageState) : undefined,
        serviceWorkers: options.serviceWorkers,
        colorScheme: options.colorScheme === null ? 'no-override' : options.colorScheme,
        reducedMotion: options.reducedMotion === null ? 'no-override' : options.reducedMotion,
        forcedColors: options.forcedColors === null ? 'no-override' : options.forcedColors,
        contrast: options.contrast === null ? 'no-override' : options.contrast,
        acceptDownloads: toAcceptDownloadsProtocol(options.acceptDownloads),
        clientCertificates: await toClientCertificatesProtocol(platform, options.clientCertificates),
    };
    if (!contextParams.recordVideo && options.videosPath) {
        contextParams.recordVideo = {
            dir: options.videosPath,
            size: options.videoSize
        };
    }
    if (contextParams.recordVideo && contextParams.recordVideo.dir)
        contextParams.recordVideo.dir = platform.path().resolve(contextParams.recordVideo.dir);
    return contextParams;
}
function toAcceptDownloadsProtocol(acceptDownloads) {
    if (acceptDownloads === undefined)
        return undefined;
    if (acceptDownloads)
        return 'accept';
    return 'deny';
}
export async function toClientCertificatesProtocol(platform, certs) {
    if (!certs)
        return undefined;
    const bufferizeContent = async (value, path) => {
        if (value)
            return value;
        if (path)
            return await platform.fs().promises.readFile(path);
    };
    return await Promise.all(certs.map(async (cert) => ({
        origin: cert.origin,
        cert: await bufferizeContent(cert.cert, cert.certPath),
        key: await bufferizeContent(cert.key, cert.keyPath),
        pfx: await bufferizeContent(cert.pfx, cert.pfxPath),
        passphrase: cert.passphrase,
    })));
}
//# sourceMappingURL=browserContext.js.map