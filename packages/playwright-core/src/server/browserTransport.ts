import type { ConnectionTransport, ProtocolRequest, ProtocolResponse } from './transport';

export type BrowserWebSocketTransportOptions = {
  protocols?: string | string[];
};

export class BrowserWebSocketTransport implements ConnectionTransport {
  private readonly _ws: WebSocket;
  readonly wsEndpoint: string;
  onmessage?: (message: ProtocolResponse) => void;
  onclose?: (reason?: string) => void;

  static async connect(url: string, options: BrowserWebSocketTransportOptions = {}): Promise<BrowserWebSocketTransport> {
    console.log('[CDP] Connecting WebSocket to:', url);
    const transport = new BrowserWebSocketTransport(url, options);
    await transport._waitForOpen();
    console.log('[CDP] WebSocket connected successfully');
    return transport;
  }

  constructor(url: string, options: BrowserWebSocketTransportOptions) {
    if (typeof WebSocket === 'undefined')
      throw new Error('WebSocket is not available in this environment');
    this.wsEndpoint = url;
    this._ws = new WebSocket(url, options.protocols);
    this._ws.addEventListener('message', event => {
      try {
        const payload = JSON.parse((event as MessageEvent).data as string);
        // Debug: log all incoming messages
        console.log('[CDP:recv]', payload.id !== undefined ? `id=${payload.id}` : payload.method, payload.sessionId ? `session=${payload.sessionId}` : '');
        this.onmessage?.(payload);
      } catch (e) {
        // Swallow malformed frames to avoid crashing the transport.
        console.warn('[BrowserWebSocketTransport] Failed to parse message', e);
      }
    });
    this._ws.addEventListener('close', event => this.onclose?.(event.reason || undefined));
    this._ws.addEventListener('error', event => this.onclose?.((event as ErrorEvent).message));
  }

  private _waitForOpen(): Promise<void> {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this._ws.removeEventListener('open', handleOpen);
        this._ws.removeEventListener('error', handleError);
      };
      const handleOpen = () => {
        cleanup();
        resolve();
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
    console.log('[CDP:send]', `id=${message.id}`, message.method, message.sessionId ? `session=${message.sessionId}` : '');
    this._ws.send(JSON.stringify(message));
  }

  close() {
    this._ws.close();
  }
}
