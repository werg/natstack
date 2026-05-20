/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { attachWithScrollback } from "./shellAttach.js";
import type { ShellApi } from "./types.js";

export const enum VscodeFlowControlConstants {
  /**
   * The number of _unacknowledged_ chars to have been sent before the pty is paused in order for
   * the client to catch up.
   */
  HighWatermarkChars = 100000,
  /**
   * After flow control pauses the pty for the client the catch up, this is the number of
   * _unacknowledged_ chars to have been caught up to on the client before resuming the pty again.
   */
  LowWatermarkChars = 5000,
  /**
   * The number characters that are accumulated on the client side before sending an ack event.
   * This must be less than or equal to LowWatermarkChars or the terminal max never unpause.
   */
  CharCountAckSize = 5000,
}

export type VscodeProcessDataEvent = {
  bytes: Uint8Array;
  data: string;
  trackCommit: boolean;
};

export class VscodeAckDataBufferer {
  private unsentCharCount = 0;

  constructor(private readonly callback: (charCount: number) => void) {}

  ack(charCount: number): void {
    this.unsentCharCount += charCount;
    while (this.unsentCharCount > VscodeFlowControlConstants.CharCountAckSize) {
      this.unsentCharCount -= VscodeFlowControlConstants.CharCountAckSize;
      this.callback(VscodeFlowControlConstants.CharCountAckSize);
    }
  }
}

export type VscodeTerminalProcessBridgeOptions = {
  sessionId: string;
  shell: ShellApi;
  onData(event: VscodeProcessDataEvent): void;
  onError(error: string): void;
};

/**
 * Natstack connectivity adapter for VS Code's terminal process-manager role.
 *
 * VS Code's `TerminalProcessManager` cannot be imported unchanged without its backend registry,
 * profile resolver, environment collections, remote authority services, telemetry, and workspace
 * services. This class keeps the upstream shape at the edge where it matters to the terminal
 * frontend: a process emits data events, accepts input/resize, has contained disposal, and tracks
 * client parse acknowledgement using VS Code's flow-control constants.
 */
export class VscodeTerminalProcessBridge {
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private disposed = false;
  private readonly ackBufferer = new VscodeAckDataBufferer(() => {
    // Our shell extension transport does not currently expose acknowledgeDataEvent. Keeping the
    // bufferer in the bridge preserves the VS Code client-side contract and makes the backend
    // upgrade straightforward when we add pause/resume support to ShellApi.
  });

  constructor(private readonly options: VscodeTerminalProcessBridgeOptions) {}

  async start(): Promise<void> {
    try {
      const response = await attachWithScrollback(this.options.shell, this.options.sessionId);
      if (this.disposed) return;
      this.reader = response.body?.getReader() ?? null;
      const decoder = new TextDecoder();
      while (!this.disposed && this.reader) {
        const next = await this.reader.read();
        if (next.done) {
          const tail = decoder.decode();
          if (tail) {
            this.options.onData({
              bytes: new Uint8Array(0),
              data: tail,
              trackCommit: false,
            });
          }
          break;
        }
        this.options.onData({
          bytes: next.value,
          data: decoder.decode(next.value, { stream: true }),
          trackCommit: false,
        });
      }
    } catch (err) {
      if (!this.disposed) {
        this.options.onError(err instanceof Error ? err.message : "Terminal output failed");
      }
    }
  }

  write(data: string): Promise<void> {
    return this.options.shell.write(this.options.sessionId, data);
  }

  resize(cols: number, rows: number): Promise<void> {
    return this.options.shell.resize(this.options.sessionId, cols, rows);
  }

  acknowledgeDataEvent(charCount: number): void {
    this.ackBufferer.ack(charCount);
  }

  dispose(): void {
    this.disposed = true;
    void this.reader?.cancel().catch(() => {});
    this.reader = null;
  }
}
