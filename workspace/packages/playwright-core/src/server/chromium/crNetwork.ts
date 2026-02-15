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

import type { CRSession } from './crConnection';
import type { CRPage } from './crBrowser';
import type { Protocol } from './protocol';
import type * as types from '../types';

export type URLMatch = string | RegExp | ((url: URL) => boolean);

/**
 * Request represents a network request.
 */
export class Request {
  private _page: CRPage;
  private _requestId: string;
  private _url: string;
  private _method: string;
  private _headers: Record<string, string>;
  private _postData: string | undefined;
  private _resourceType: string;
  private _redirectedFrom: Request | null = null;
  private _redirectedTo: Request | null = null;
  private _response: Response | null = null;
  private _failureText: string | null = null;
  private _isNavigationRequest: boolean;

  constructor(
    page: CRPage,
    requestId: string,
    url: string,
    method: string,
    headers: Record<string, string>,
    postData: string | undefined,
    resourceType: string,
    isNavigationRequest: boolean
  ) {
    this._page = page;
    this._requestId = requestId;
    this._url = url;
    this._method = method;
    this._headers = headers;
    this._postData = postData;
    this._resourceType = resourceType;
    this._isNavigationRequest = isNavigationRequest;
  }

  url(): string {
    return this._url;
  }

  method(): string {
    return this._method;
  }

  headers(): Record<string, string> {
    return { ...this._headers };
  }

  postData(): string | null {
    return this._postData ?? null;
  }

  postDataJSON(): unknown | null {
    const postData = this.postData();
    if (!postData)
      return null;

    const contentType = this._headers['content-type'] || this._headers['Content-Type'];
    if (contentType?.includes('application/x-www-form-urlencoded')) {
      const entries: Record<string, string> = {};
      const parsed = new URLSearchParams(postData);
      for (const [k, v] of parsed.entries())
        entries[k] = v;
      return entries;
    }

    try {
      return JSON.parse(postData);
    } catch {
      throw new Error('POST data is not a valid JSON object: ' + postData);
    }
  }

  resourceType(): string {
    return this._resourceType;
  }

  isNavigationRequest(): boolean {
    return this._isNavigationRequest;
  }

  redirectedFrom(): Request | null {
    return this._redirectedFrom;
  }

  redirectedTo(): Request | null {
    return this._redirectedTo;
  }

  failure(): { errorText: string } | null {
    return this._failureText ? { errorText: this._failureText } : null;
  }

  async response(): Promise<Response | null> {
    return this._response;
  }

  _setResponse(response: Response): void {
    this._response = response;
  }

  _setRedirectedFrom(request: Request): void {
    this._redirectedFrom = request;
    request._redirectedTo = this;
  }

  _setFailure(text: string): void {
    this._failureText = text;
  }
}

/**
 * Response represents a network response.
 */
export class Response {
  private _request: Request;
  private _url: string;
  private _status: number;
  private _statusText: string;
  private _headers: Record<string, string>;
  private _body: Uint8Array | null = null;
  private _bodyPromise: Promise<Uint8Array> | null = null;
  private _session: CRSession;
  private _requestId: string;

  constructor(
    request: Request,
    session: CRSession,
    requestId: string,
    url: string,
    status: number,
    statusText: string,
    headers: Record<string, string>
  ) {
    this._request = request;
    this._session = session;
    this._requestId = requestId;
    this._url = url;
    this._status = status;
    this._statusText = statusText;
    this._headers = headers;
    request._setResponse(this);
  }

  url(): string {
    return this._url;
  }

  status(): number {
    return this._status;
  }

  statusText(): string {
    return this._statusText;
  }

  headers(): Record<string, string> {
    return { ...this._headers };
  }

  ok(): boolean {
    return this._status >= 200 && this._status < 300;
  }

  request(): Request {
    return this._request;
  }

  async body(): Promise<Uint8Array> {
    if (this._body)
      return this._body;

    if (!this._bodyPromise) {
      this._bodyPromise = this._fetchBody();
    }
    return this._bodyPromise;
  }

  private async _fetchBody(): Promise<Uint8Array> {
    try {
      const result = await this._session.send('Network.getResponseBody', {
        requestId: this._requestId,
      });

      if (result.base64Encoded) {
        const binaryString = atob(result.body);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
          bytes[i] = binaryString.charCodeAt(i);
        }
        this._body = bytes;
      } else {
        const encoder = new TextEncoder();
        this._body = encoder.encode(result.body);
      }
      return this._body;
    } catch {
      return new Uint8Array(0);
    }
  }

  async text(): Promise<string> {
    const body = await this.body();
    return new TextDecoder().decode(body);
  }

  async json(): Promise<unknown> {
    const text = await this.text();
    return JSON.parse(text);
  }
}

/**
 * Route represents an intercepted route.
 */
export class Route {
  private _request: Request;
  private _session: CRSession;
  private _requestId: string;
  private _handled = false;

  constructor(request: Request, session: CRSession, requestId: string) {
    this._request = request;
    this._session = session;
    this._requestId = requestId;
  }

  request(): Request {
    return this._request;
  }

  /**
   * Continue the request.
   */
  async continue(options?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    postData?: string;
  }): Promise<void> {
    if (this._handled)
      throw new Error('Route already handled');
    this._handled = true;

    const continueParams: Protocol.Fetch.continueRequestParameters = {
      requestId: this._requestId,
    };

    if (options?.url)
      continueParams.url = options.url;
    if (options?.method)
      continueParams.method = options.method;
    if (options?.headers) {
      continueParams.headers = Object.entries(options.headers).map(([name, value]) => ({ name, value }));
    }
    if (options?.postData) {
      continueParams.postData = btoa(options.postData);
    }

    await this._session.send('Fetch.continueRequest', continueParams);
  }

  /**
   * Fulfill the request with a response.
   */
  async fulfill(options?: {
    status?: number;
    headers?: Record<string, string>;
    contentType?: string;
    body?: string | Uint8Array;
    json?: unknown;
  }): Promise<void> {
    if (this._handled)
      throw new Error('Route already handled');
    this._handled = true;

    let body = '';
    let contentType = options?.contentType;

    if (options?.json !== undefined) {
      body = JSON.stringify(options.json);
      contentType = contentType || 'application/json';
    } else if (options?.body) {
      if (typeof options.body === 'string') {
        body = btoa(options.body);
      } else {
        // Uint8Array
        const bytes = options.body;
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        body = btoa(binary);
      }
    }

    const headers: Protocol.Fetch.HeaderEntry[] = [];
    if (options?.headers) {
      for (const [name, value] of Object.entries(options.headers)) {
        headers.push({ name, value });
      }
    }
    if (contentType && !headers.some(h => h.name.toLowerCase() === 'content-type')) {
      headers.push({ name: 'Content-Type', value: contentType });
    }

    await this._session.send('Fetch.fulfillRequest', {
      requestId: this._requestId,
      responseCode: options?.status ?? 200,
      responseHeaders: headers,
      body,
    });
  }

  /**
   * Abort the request.
   */
  async abort(errorCode?: string): Promise<void> {
    if (this._handled)
      throw new Error('Route already handled');
    this._handled = true;

    await this._session.send('Fetch.failRequest', {
      requestId: this._requestId,
      errorReason: (errorCode as Protocol.Network.ErrorReason) || 'Failed',
    });
  }
}

/**
 * NetworkManager handles network events and routing.
 */
export class NetworkManager {
  private _page: CRPage;
  private _session: CRSession;
  private _requests = new Map<string, Request>();
  private _routes: Array<{ urlMatch: URLMatch; handler: (route: Route, request: Request) => Promise<void> | void }> = [];
  private _interceptionEnabled = false;

  constructor(page: CRPage, session: CRSession) {
    this._page = page;
    this._session = session;
  }

  async initialize(): Promise<void> {
    // Set up event listeners
    this._session.on('Network.requestWillBeSent', this._onRequestWillBeSent.bind(this));
    this._session.on('Network.responseReceived', this._onResponseReceived.bind(this));
    this._session.on('Network.loadingFinished', this._onLoadingFinished.bind(this));
    this._session.on('Network.loadingFailed', this._onLoadingFailed.bind(this));
    this._session.on('Fetch.requestPaused', this._onRequestPaused.bind(this));
  }

  async route(urlMatch: URLMatch, handler: (route: Route, request: Request) => Promise<void> | void): Promise<void> {
    this._routes.push({ urlMatch, handler });
    await this._updateInterception();
  }

  async unroute(urlMatch: URLMatch, handler?: (route: Route, request: Request) => Promise<void> | void): Promise<void> {
    this._routes = this._routes.filter(r => {
      if (handler)
        return r.urlMatch !== urlMatch || r.handler !== handler;
      return r.urlMatch !== urlMatch;
    });
    await this._updateInterception();
  }

  private async _updateInterception(): Promise<void> {
    const enabled = this._routes.length > 0;
    if (enabled === this._interceptionEnabled)
      return;

    this._interceptionEnabled = enabled;

    if (enabled) {
      await this._session.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      });
    } else {
      await this._session.send('Fetch.disable');
    }
  }

  private _onRequestWillBeSent(event: Protocol.Network.requestWillBeSentPayload): void {
    const request = new Request(
      this._page,
      event.requestId,
      event.request.url,
      event.request.method,
      event.request.headers as Record<string, string>,
      event.request.postData,
      event.type || 'other',
      event.type === 'Document'
    );

    // Handle redirects
    if (event.redirectResponse) {
      const redirectedFrom = this._requests.get(event.requestId);
      if (redirectedFrom) {
        request._setRedirectedFrom(redirectedFrom);
        this._requests.delete(event.requestId);
      }
    }

    this._requests.set(event.requestId, request);
    this._page.emit('request', request);
  }

  private _onResponseReceived(event: Protocol.Network.responseReceivedPayload): void {
    const request = this._requests.get(event.requestId);
    if (!request)
      return;

    const response = new Response(
      request,
      this._session,
      event.requestId,
      event.response.url,
      event.response.status,
      event.response.statusText,
      event.response.headers as Record<string, string>
    );

    this._page.emit('response', response);
  }

  private _onLoadingFinished(event: Protocol.Network.loadingFinishedPayload): void {
    const request = this._requests.get(event.requestId);
    if (!request)
      return;

    this._page.emit('requestfinished', request);
    this._requests.delete(event.requestId);
  }

  private _onLoadingFailed(event: Protocol.Network.loadingFailedPayload): void {
    const request = this._requests.get(event.requestId);
    if (!request)
      return;

    request._setFailure(event.errorText);
    this._page.emit('requestfailed', request);
    this._requests.delete(event.requestId);
  }

  private async _onRequestPaused(event: Protocol.Fetch.requestPausedPayload): Promise<void> {
    const request = new Request(
      this._page,
      event.requestId,
      event.request.url,
      event.request.method,
      event.request.headers as Record<string, string>,
      event.request.postData,
      event.resourceType || 'other',
      event.resourceType === 'Document'
    );

    const route = new Route(request, this._session, event.requestId);

    // Find a matching route handler
    for (const { urlMatch, handler } of this._routes) {
      if (this._matchUrl(request.url(), urlMatch)) {
        try {
          await handler(route, request);
          return;
        } catch (error) {
          console.error('Route handler error:', error);
          // Continue if handler doesn't handle it
        }
      }
    }

    // No handler matched, continue the request
    await route.continue();
  }

  private _matchUrl(url: string, match: URLMatch): boolean {
    if (typeof match === 'string') {
      // Simple string matching with glob support
      if (match.includes('*')) {
        const pattern = match.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
        return new RegExp(`^${pattern}$`).test(url);
      }
      return url === match || url.includes(match);
    }
    if (match instanceof RegExp) {
      return match.test(url);
    }
    if (typeof match === 'function') {
      try {
        return match(new URL(url));
      } catch {
        return false;
      }
    }
    return false;
  }
}
