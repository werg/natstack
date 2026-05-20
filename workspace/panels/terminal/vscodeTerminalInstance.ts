/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { NotificationStreamParser, type ParsedNotification } from "./notificationParser.js";
import type { XtermTheme } from "./paneTheme.js";
import {
  VscodeTerminalProcessBridge,
  type VscodeProcessDataEvent,
} from "./vscodeTerminalProcess.js";
import { VscodeTerminalResizeDebouncer } from "./vscodeTerminalResizeDebouncer.js";
import { VscodeTerminalWriteScheduler } from "./vscodeTerminalWriteScheduler.js";
import type {
  TerminalFindResult,
  TerminalFrontend,
  TerminalFrontendFactory,
  TerminalSearchOptions,
} from "./terminalFrontend.js";
import type { ShellApi } from "./types.js";
import type { VscodeShellIntegrationEvent } from "./vscodeShellIntegration.js";

type Disposable = { dispose(): void };

export type VscodeTerminalInstanceOptions = {
  sessionId: string;
  shell: ShellApi;
  frontendFactory: TerminalFrontendFactory;
  fontFamily: string;
  fontSize: number;
  theme: XtermTheme;
  focused: boolean;
  onError(error: string): void;
  onNotification(notification: ParsedNotification): void;
  onFindResult?(result: TerminalFindResult): void;
  onScrollStateChange?(scrolledUp: boolean): void;
  onShellIntegrationEvent?(event: VscodeShellIntegrationEvent): void;
  onLineData?(line: string): void;
};

export class VscodeTerminalInstance {
  private frontend: TerminalFrontend | null = null;
  private process: VscodeTerminalProcessBridge | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private resizeDebouncer: VscodeTerminalResizeDebouncer | null = null;
  private writeScheduler: VscodeTerminalWriteScheduler | null = null;
  private disposables: Disposable[] = [];
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private readonly notificationParser = new NotificationStreamParser();
  private autoScroll = true;
  private onNotification: (notification: ParsedNotification) => void;
  private onError: (error: string) => void;

  constructor(private readonly options: VscodeTerminalInstanceOptions) {
    this.onNotification = options.onNotification;
    this.onError = options.onError;
  }

  updateCallbacks(callbacks: {
    onError?: (error: string) => void;
    onNotification?: (notification: ParsedNotification) => void;
    onScrollStateChange?: (scrolledUp: boolean) => void;
    onShellIntegrationEvent?: (event: VscodeShellIntegrationEvent) => void;
    onLineData?: (line: string) => void;
  }): void {
    if (callbacks.onError) this.onError = callbacks.onError;
    if (callbacks.onNotification) this.onNotification = callbacks.onNotification;
    if (callbacks.onScrollStateChange) {
      this.options.onScrollStateChange = callbacks.onScrollStateChange;
      this.updateScrollState();
    }
    if (callbacks.onShellIntegrationEvent) {
      this.options.onShellIntegrationEvent = callbacks.onShellIntegrationEvent;
    }
    if (callbacks.onLineData) this.options.onLineData = callbacks.onLineData;
  }

  async attach(host: HTMLElement): Promise<void> {
    try {
      const frontend = await this.options.frontendFactory({
        fontFamily: this.options.fontFamily,
        fontSize: this.options.fontSize,
        theme: this.options.theme,
        onFindResult: this.options.onFindResult,
      });
      if (this.disposed) {
        safeDispose(frontend);
        return;
      }
      this.frontend = frontend;
      frontend.open(host);
      if (this.options.focused) frontend.focus();
      this.updateScrollState();

      this.resizeObserver = new ResizeObserver(() => {
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => this.frontend?.fit(), 50);
      });
      this.resizeObserver.observe(host);

      this.process = new VscodeTerminalProcessBridge({
        sessionId: this.options.sessionId,
        shell: this.options.shell,
        onData: (event) => this.handleProcessData(event),
        onError: this.onError,
      });
      this.writeScheduler = new VscodeTerminalWriteScheduler({
        target: () => this.frontend,
        acknowledge: (charCount) => this.process?.acknowledgeDataEvent(charCount),
        onWillData: (data) => {
          for (const notification of this.notificationParser.push(data)) {
            this.onNotification(notification);
          }
        },
        onData: () => {
          if (this.autoScroll) this.frontend?.scrollToBottom();
          this.updateScrollState();
        },
      });
      let latestCols = 0;
      let latestRows = 0;
      this.resizeDebouncer = new VscodeTerminalResizeDebouncer(
        () => true,
        () => frontend.getBufferLength(),
        (cols, rows) => {
          latestCols = cols;
          latestRows = rows;
          void this.process?.resize(cols, rows).catch(() => {});
        },
        (cols) => {
          latestCols = cols;
          if (latestRows > 0) void this.process?.resize(latestCols, latestRows).catch(() => {});
        },
        (rows) => {
          latestRows = rows;
          if (latestCols > 0) void this.process?.resize(latestCols, latestRows).catch(() => {});
        }
      );

      this.disposables.push(
        frontend.onInput((data) => {
          void this.process?.write(data).catch((err) => {
            this.onError(err instanceof Error ? err.message : "Terminal input failed");
          });
        }),
        frontend.onResize(({ cols, rows }) => {
          this.resizeDebouncer?.resize(cols, rows, false);
        }),
        frontend.onScroll?.(() => this.updateScrollState()) ?? noopDisposable,
        frontend.onShellIntegrationEvent?.((event) =>
          this.options.onShellIntegrationEvent?.(event)
        ) ?? noopDisposable,
        frontend.onLineData?.((line) =>
          this.options.onLineData?.(line)
        ) ?? noopDisposable
      );

      await this.process.start();
    } catch (err) {
      if (!this.disposed) this.onError(err instanceof Error ? err.message : "Terminal failed to load");
    }
  }

  focus(): void {
    this.frontend?.focus();
  }

  fit(): void {
    this.frontend?.fit();
  }

  setTheme(theme: XtermTheme): void {
    this.frontend?.setTheme(theme);
  }

  getSelection(): string {
    return this.frontend?.getSelection() ?? "";
  }

  selectAll(): void {
    this.frontend?.selectAll();
  }

  scrollToBottom(): void {
    this.frontend?.scrollToBottom();
    this.autoScroll = true;
    this.options.onScrollStateChange?.(false);
  }

  findNext(query: string, opts?: TerminalSearchOptions): boolean {
    return this.frontend?.findNext(query, opts) ?? false;
  }

  findPrevious(query: string, opts?: TerminalSearchOptions): boolean {
    return this.frontend?.findPrevious(query, opts) ?? false;
  }

  clearSearch(): void {
    this.frontend?.clearSearch();
  }

  serialize(): string {
    return this.frontend?.serialize() ?? "";
  }

  dispose(): void {
    this.disposed = true;
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeObserver?.disconnect();
    this.resizeDebouncer?.flush();
    this.resizeDebouncer?.dispose();
    this.process?.dispose();
    for (const disposable of this.disposables) safeDispose(disposable);
    safeDispose(this.frontend);
    this.disposables = [];
    this.frontend = null;
    this.process = null;
    this.resizeDebouncer = null;
    this.writeScheduler = null;
  }

  private handleProcessData(event: VscodeProcessDataEvent): void {
    void this.writeScheduler?.writeProcessData(event.data, event.trackCommit);
  }

  private updateScrollState(): void {
    const scrolledUp = this.frontend?.isScrolledUp() ?? false;
    this.autoScroll = !scrolledUp;
    if (!this.disposed) this.options.onScrollStateChange?.(scrolledUp);
  }
}

const noopDisposable = { dispose() {} };

function safeDispose(disposable: Disposable | null | undefined): void {
  try {
    disposable?.dispose();
  } catch (err) {
    console.warn("Terminal cleanup failed", err);
  }
}
