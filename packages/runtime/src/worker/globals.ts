// Access globals via globalThis to support VM sandbox environments
// where globals are set on the context object
const g = globalThis as unknown as {
  __consoleLog?: (...args: unknown[]) => void;
  __consoleError?: (...args: unknown[]) => void;
  __consoleWarn?: (...args: unknown[]) => void;
  __consoleInfo?: (...args: unknown[]) => void;
  console?: Partial<Console>;
};

export function setupWorkerGlobals(): void {
  if (typeof g.__consoleLog !== "undefined") {
    g.console = {
      log: g.__consoleLog,
      error: g.__consoleError,
      warn: g.__consoleWarn,
      info: g.__consoleInfo,
      debug: g.__consoleLog,
    };
  }

  // Note: process.env is now set up in the worker sandbox (utilityEntry.ts)
  // with the injected environment variables. No need to set it up here.
}
