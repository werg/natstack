/**
 * Quiescence-debounced flush controller.
 *
 * The editor notifies us on every `onChange`. After `QUIESCENCE_MS` of no
 * further changes for an open file we fire a flush; an explicit `flushNow`
 * (the toolbar button) fires immediately regardless of the timer.
 */

const QUIESCENCE_MS = 1500;

export interface FlushController {
  noteChange(path: string): void;
  flushNow(path: string): void;
  flushPending(): void;
  dispose(): void;
}

export interface FlushControllerOptions {
  onFlush: (path: string) => void | Promise<void>;
  quiescenceMs?: number;
}

export function createFlushController(opts: FlushControllerOptions): FlushController {
  const quiescenceMs = opts.quiescenceMs ?? QUIESCENCE_MS;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let disposed = false;

  function clear(path: string) {
    const existing = timers.get(path);
    if (existing) {
      clearTimeout(existing);
      timers.delete(path);
    }
  }

  function fire(path: string) {
    clear(path);
    if (disposed) return;
    try {
      void Promise.resolve(opts.onFlush(path)).catch((err) => {
        console.warn("[Spectrolite] flush handler threw:", err);
      });
    } catch (err) {
      console.warn("[Spectrolite] flush handler threw synchronously:", err);
    }
  }

  return {
    noteChange(path: string) {
      if (disposed) return;
      clear(path);
      const t = setTimeout(() => fire(path), quiescenceMs);
      timers.set(path, t);
    },
    flushNow(path: string) {
      fire(path);
    },
    flushPending() {
      for (const path of [...timers.keys()]) fire(path);
    },
    dispose() {
      disposed = true;
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}
