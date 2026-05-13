export type RecoveryKind = "resubscribe" | "cold-recover";

type Handler = {
  name: string;
  fn: () => Promise<void> | void;
};

export interface RecoveryCoordinator {
  registerResubscribeHandler(name: string, fn: () => Promise<void> | void): () => void;
  registerColdRecoverHandler(name: string, fn: () => Promise<void> | void): () => void;
  run(kind: RecoveryKind): Promise<void>;
}

export class DefaultRecoveryCoordinator implements RecoveryCoordinator {
  private handlers: Record<RecoveryKind, Map<string, Handler>> = {
    resubscribe: new Map(),
    "cold-recover": new Map(),
  };
  private generation = 0;
  private completedGeneration: Partial<Record<RecoveryKind, number>> = {};
  private queue: Promise<void> = Promise.resolve();

  registerResubscribeHandler(name: string, fn: () => Promise<void> | void): () => void {
    return this.register("resubscribe", name, fn);
  }

  registerColdRecoverHandler(name: string, fn: () => Promise<void> | void): () => void {
    return this.register("cold-recover", name, fn);
  }

  async run(kind: RecoveryKind): Promise<void> {
    if (kind === "resubscribe") {
      this.generation++;
    }
    const generation = this.generation;
    this.queue = this.queue.then(() => this.runHandlers(kind, generation));
    return this.queue;
  }

  private register(
    kind: RecoveryKind,
    name: string,
    fn: () => Promise<void> | void,
  ): () => void {
    const handler = { name, fn };
    this.handlers[kind].set(name, handler);

    if (kind === "resubscribe" && this.completedGeneration[kind] === this.generation) {
      queueMicrotask(() => {
        if (this.handlers[kind].get(name) === handler) {
          void this.runOne(kind, handler);
        }
      });
    }

    return () => {
      if (this.handlers[kind].get(name) === handler) {
        this.handlers[kind].delete(name);
      }
    };
  }

  private async runHandlers(kind: RecoveryKind, generation: number): Promise<void> {
    const handlers = kind === "cold-recover"
      ? [...this.handlers[kind].values()]
      : this.handlers[kind].values();
    for (const handler of handlers) {
      if (this.handlers[kind].get(handler.name) !== handler) continue;
      await this.runOne(kind, handler);
    }
    this.completedGeneration[kind] = generation;
  }

  private async runOne(kind: RecoveryKind, handler: Handler): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await handler.fn();
        return;
      } catch (error) {
        console.warn(
          `[RecoveryCoordinator] ${kind} handler "${handler.name}" failed` +
            ` (attempt ${attempt}/${maxAttempts}):`,
          error,
        );
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(250 * 2 ** (attempt - 1), 1000)));
        }
      }
    }
    console.warn(
      `[RecoveryCoordinator] ${kind} handler "${handler.name}" exhausted all ${maxAttempts} attempts`,
    );
  }
}

export function createRecoveryCoordinator(): DefaultRecoveryCoordinator {
  return new DefaultRecoveryCoordinator();
}
