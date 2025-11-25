/**
 * Typed RPC API for the child panel
 * Export this so parent panels can import it for type safety
 */

export interface RpcDemoChildApi {
  ping(): Promise<string>;
  echo(message: string): Promise<string>;
  getCounter(): Promise<number>;
  incrementCounter(amount?: number): Promise<number>;
  resetCounter(): Promise<void>;
  getInfo(): Promise<{ panelId: string; counter: number }>;
}
