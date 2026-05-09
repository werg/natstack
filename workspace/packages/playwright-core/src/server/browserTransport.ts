import type { ConnectionTransport, ProtocolRequest, ProtocolResponse } from './transport';

export type BrowserWebSocketTransportOptions = {
  protocols?: string | string[];
  authToken?: string;
};

export class BrowserWebSocketTransport implements ConnectionTransport {
  private readonly _ws: WebSocket;
  private readonly _authToken?: string;
  readonly wsEndpoint: string;
  onmessage?: (message: ProtocolResponse) => void;
  onclose?: (reason?: string) => void;

  static async connect(url: string, options: BrowserWebSocketTransportOptions = {}): Promise<BrowserWebSocketTransport> {
    const transport = new BrowserWebSocketTransport(url, options);
    await transport._waitForOpen();
    return transport;
  }

  constructor(url: string, options: BrowserWebSocketTransportOptions) {
    if (typeof WebSocket === 'undefined')
      throw new Error('WebSocket is not available in this environment');
    this.wsEndpoint = url;
    this._authToken = options.authToken;
    this._ws = new WebSocket(url, options.protocols);
    this._ws.addEventListener('message', event => {
      try {
        const payload = JSON.parse((event as MessageEvent).data as string);
        if (payload?.type === 'natstack:cdp-auth-ok')
          return;
        this.onmessage?.(payload);
      } catch (e) {
        // Swallow malformed frames to avoid crashing the transport.
        console.warn('[BrowserWebSocketTransport] Failed to parse message', e);
      }
    });
    this._ws.addEventListener('close', event => {
      this.onclose?.(event.reason || `WebSocket closed with code ${event.code}`);
    });
    this._ws.addEventListener('error', event => {
      console.error('[CDP] WebSocket error:', (event as ErrorEvent).message);
      this.onclose?.((event as ErrorEvent).message);
    });
  }

  private _waitForOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this._ws.removeEventListener('open', handleOpen);
        this._ws.removeEventListener('error', handleError);
      };
      const handleOpen = () => {
        if (!this._authToken) {
          cleanup();
          resolve();
          return;
        }
        const handleAuthMessage = (event: MessageEvent) => {
          try {
            const payload = JSON.parse(event.data as string) as { type?: string };
            if (payload.type !== 'natstack:cdp-auth-ok')
              throw new Error('CDP authentication failed');
            cleanupAuth();
            resolve();
          } catch (err) {
            cleanupAuth();
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        };
        const handleAuthClose = (event: CloseEvent) => {
          cleanupAuth();
          reject(new Error(event.reason || `CDP authentication failed with close code ${event.code}`));
        };
        const cleanupAuth = () => {
          cleanup();
          this._ws.removeEventListener('message', handleAuthMessage);
          this._ws.removeEventListener('close', handleAuthClose);
        };
        this._ws.addEventListener('message', handleAuthMessage);
        this._ws.addEventListener('close', handleAuthClose);
        this._ws.send(JSON.stringify({
          type: 'natstack:cdp-auth',
          token: this._authToken,
        }));
      };
      const handleError = (event: Event) => {
        cleanup();
        reject(new Error((event as ErrorEvent).message || 'WebSocket connection failed'));
      };
      this._ws.addEventListener('open', handleOpen);
      this._ws.addEventListener('error', handleError);
    });
  }

  send(message: ProtocolRequest) {
    this._ws.send(JSON.stringify(message));
  }

  close() {
    this._ws.close();
  }
}
