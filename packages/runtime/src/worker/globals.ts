// Access globals via globalThis to support VM sandbox environments
// where globals are set on the context object
const g = globalThis as unknown as {
  __natstackEnv?: Record<string, string>;
  __consoleLog?: (...args: unknown[]) => void;
  __consoleError?: (...args: unknown[]) => void;
  __consoleWarn?: (...args: unknown[]) => void;
  __consoleInfo?: (...args: unknown[]) => void;
  console?: Partial<Console>;
  process?: { env?: Record<string, string> };
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

  // Provide a minimal process.env for libraries that expect it.
  const env = g.__natstackEnv ?? {};
  if (typeof g.process === "undefined") {
    g.process = { env };
  } else if (typeof g.process?.env === "undefined") {
    g.process.env = env;
  }
}
