export interface WsLike {
  readonly readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface WsTransportAdapter {
  createSocket(url: string): WsLike;
  getAuthToken(): Promise<string>;
  refreshAuthToken?(): Promise<string>;
  now(): number;
}
