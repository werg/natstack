import { NotebookKernel } from "@natstack/notebook-kernel";
import type { KernelOptions, ExecutionOptions } from "@natstack/notebook-kernel";
import type { CellResult, ConsoleEntry } from "@natstack/notebook-kernel";
import type { FileSystem } from "../storage/ChatStore";
import type { CodeLanguage } from "../types/messages";
import { createReactMount, type ReactMountRegistry } from "./ReactMount";

export type { CellResult, ConsoleEntry };

/**
 * Adapter interface for channel communication.
 * Allows KernelManager to work with different channel implementations.
 */
export interface KernelChannelAdapter {
  sendMessage(message: {
    participantId: string;
    participantType: "user" | "agent" | "kernel" | "system";
    content: {
      type: "code";
      code: string;
      language: CodeLanguage;
      source: "user" | "agent";
    } | {
      type: "code_result";
      success: boolean;
      result: unknown;
      error?: string;
      consoleOutput: ConsoleEntry[];
      reactMountId?: string;
      executionTime: number;
      constNames?: string[];
      mutableNames?: string[];
    };
    responseTo?: string;
  }): string;
  getAgentId(): string;
}

/**
 * Extended kernel options for the manager.
 */
export interface KernelManagerOptions extends KernelOptions {
  /** Channel adapter for sending messages */
  channel?: KernelChannelAdapter;
  /** Participant ID for kernel messages */
  participantId?: string;
}

/**
 * KernelManager - Wraps @natstack/notebook-kernel with additional features.
 *
 * Features:
 * - React mount support (mount() function in kernel scope)
 * - Channel integration for sending result messages
 * - Default bindings injection (fs, git, React, Radix)
 * - Session lifecycle management
 */
export class KernelManager {
  private kernel: NotebookKernel;
  private sessionId: string | null = null;
  private channel: KernelChannelAdapter | null;
  private participantId: string;
  private mountRegistry: ReactMountRegistry;
  private executionCount = 0;
  private ready = false;

  constructor(options: KernelManagerOptions = {}) {
    this.kernel = new NotebookKernel({
      typescript: true,
      jsx: true,
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
      forwardConsole: true,
      ...options,
    });
    this.channel = options.channel ?? null;
    this.participantId = options.participantId ?? "kernel";
    this.mountRegistry = createReactMount();
  }

  /**
   * Initialize the kernel.
   */
  async initialize(): Promise<void> {
    if (this.sessionId) {
      throw new Error("Kernel already initialized");
    }

    this.sessionId = this.kernel.createSession({});

    // Inject React mount and default bindings
    this.injectDefaultBindings();
    this.ready = true;
  }

  /**
   * Check if the kernel is ready.
   */
  isReady(): boolean {
    return this.ready && this.sessionId !== null;
  }

  /**
   * Get the current session ID.
   */
  getSessionId(): string | null {
    return this.sessionId;
  }

  /**
   * Get the execution count.
   */
  getExecutionCount(): number {
    return this.executionCount;
  }

  /**
   * Execute code in the kernel.
   * Wrapped in try/catch for atomic execution - always returns a result.
   */
  async execute(
    code: string,
    options: ExecutionOptions = {}
  ): Promise<CellResult> {
    if (!this.sessionId) {
      throw new Error("Kernel not initialized");
    }

    try {
      const result = await this.kernel.execute(this.sessionId, code, options);
      this.executionCount++;

      // Check if result contains a React component to mount
      this.checkForReactMount(result.result);

      return result;
    } catch (error) {
      // Handle unexpected kernel errors gracefully
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        success: false,
        result: undefined,
        error: error instanceof Error ? error : new Error(errorMessage),
        output: [],
        constNames: [],
        mutableNames: [],
      };
    }
  }

  /**
   * Execute code from the agent (tool call).
   * Does not send channel messages - the tool_call already shows the code
   * in its args, and the tool_result contains the output.
   */
  async executeFromAgent(
    code: string,
    _language: CodeLanguage = "typescript",
    options: ExecutionOptions = {}
  ): Promise<CellResult> {
    return this.execute(code, options);
  }

  /**
   * Execute code from the user.
   * Sends messages to the channel.
   */
  async executeFromUser(
    code: string,
    language: CodeLanguage = "typescript",
    userId: string,
    options: ExecutionOptions = {}
  ): Promise<CellResult> {
    if (!this.channel) {
      return this.execute(code, options);
    }

    // Send code message from user
    const codeMsgId = this.channel.sendMessage({
      participantId: userId,
      participantType: "user",
      content: {
        type: "code",
        code,
        language,
        source: "user",
      },
    });

    // Execute and get result
    const startTime = Date.now();
    const result = await this.execute(code, options);
    const executionTime = Date.now() - startTime;

    // Check for React mount
    const reactMountId = this.checkForReactMount(result.result);

    // Send result message from kernel
    this.channel.sendMessage({
      participantId: this.participantId,
      participantType: "kernel",
      content: {
        type: "code_result",
        success: result.success,
        result: result.result,
        error: result.error?.message,
        consoleOutput: result.output,
        reactMountId,
        executionTime,
        constNames: result.constNames,
        mutableNames: result.mutableNames,
      },
      responseTo: codeMsgId,
    });

    return result;
  }

  /**
   * Inject bindings into the kernel scope.
   */
  injectBindings(bindings: Record<string, unknown>, mutable = true): void {
    if (!this.sessionId) {
      throw new Error("Kernel not initialized");
    }
    this.kernel.injectBindings(this.sessionId, bindings, mutable);
  }

  /**
   * Inject default bindings (React, mount, fs shim, etc.).
   */
  private injectDefaultBindings(): void {
    if (!this.sessionId) return;

    // Create mount function that captures rendered components
    const mount = this.mountRegistry.createMountFunction();

    this.kernel.injectBindings(
      this.sessionId,
      {
        // React mounting
        mount,
        // Note: React and ReactDOM should be imported dynamically in cells
        // to avoid bundling issues. They're available via importModule('react')
      },
      false // These bindings are not mutable
    );
  }

  /**
   * Inject filesystem bindings.
   */
  injectFileSystemBindings(fs: FileSystem): void {
    if (!this.sessionId) return;

    this.kernel.injectBindings(
      this.sessionId,
      { fs },
      false
    );
  }

  /**
   * Get the current scope.
   */
  getScope(): Record<string, unknown> {
    if (!this.sessionId) {
      return {};
    }
    return this.kernel.getScope(this.sessionId);
  }

  /**
   * Reset the kernel session.
   */
  reset(keepBindings?: string[]): void {
    if (!this.sessionId) return;

    // Always keep the mount function
    const keep = keepBindings
      ? [...keepBindings, "mount"]
      : ["mount"];

    this.kernel.resetSession(this.sessionId, keep);
    this.executionCount = 0;
    this.mountRegistry.clear();
  }

  /**
   * Get the mount container for a specific mount ID.
   */
  getMountContainer(mountId: string): HTMLElement | null {
    return this.mountRegistry.getContainer(mountId);
  }

  /**
   * Get all mount IDs.
   */
  getMountIds(): string[] {
    return this.mountRegistry.getMountIds();
  }

  /**
   * Get the mount registry for React rendering.
   */
  getMountRegistry(): ReactMountRegistry {
    return this.mountRegistry;
  }

  /**
   * Destroy the kernel and clean up.
   */
  destroy(): void {
    if (this.sessionId) {
      this.kernel.destroySession(this.sessionId);
      this.sessionId = null;
    }
    this.mountRegistry.clear();
    this.ready = false;
  }

  /**
   * Check if a result is a React element and register it for mounting.
   */
  private checkForReactMount(result: unknown): string | undefined {
    // Check if result looks like a React element
    if (
      result &&
      typeof result === "object" &&
      "$$typeof" in result &&
      (result as { $$typeof: symbol }).$$typeof === Symbol.for("react.element")
    ) {
      // Cast to React.ReactNode since we've verified it's a React element
      const mountId = this.mountRegistry.registerElement(result as unknown as React.ReactNode);
      return mountId;
    }
    return undefined;
  }
}
