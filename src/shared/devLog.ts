/**
 * Simple development logging utility with log levels.
 *
 * Controls verbosity of console output during development.
 * Set NATSTACK_LOG_LEVEL environment variable to control output:
 *   - "verbose" - All logs including detailed debug info
 *   - "info" - Normal operational logs (default)
 *   - "warn" - Warnings and errors only
 *   - "error" - Errors only
 *   - "silent" - No logs
 */

export type LogLevel = "verbose" | "info" | "warn" | "error" | "silent";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  verbose: 0,
  info: 1,
  warn: 2,
  error: 3,
  silent: 4,
};

function getLogLevel(): LogLevel {
  const level = process.env["NATSTACK_LOG_LEVEL"] as LogLevel | undefined;
  if (level && level in LOG_LEVEL_PRIORITY) {
    return level;
  }
  return "info";
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[getLogLevel()];
}

/**
 * Log at verbose level - detailed debug information.
 * Use for: database operations, cache hits, internal state changes.
 */
export function logVerbose(tag: string, message: string, ...args: unknown[]): void {
  if (shouldLog("verbose")) {
    console.log(`[${tag}] ${message}`, ...args);
  }
}

/**
 * Log at info level - normal operational messages.
 * Use for: server startup, significant state changes.
 */
export function logInfo(tag: string, message: string, ...args: unknown[]): void {
  if (shouldLog("info")) {
    console.log(`[${tag}] ${message}`, ...args);
  }
}

/**
 * Log at warn level - potential issues.
 * Use for: missing optional config, degraded functionality.
 */
export function logWarn(tag: string, message: string, ...args: unknown[]): void {
  if (shouldLog("warn")) {
    console.warn(`[${tag}] ${message}`, ...args);
  }
}

/**
 * Log at error level - actual errors.
 */
export function logError(tag: string, message: string, ...args: unknown[]): void {
  if (shouldLog("error")) {
    console.error(`[${tag}] ${message}`, ...args);
  }
}

/**
 * Check if verbose logging is enabled.
 * Useful for conditionally computing expensive log data.
 */
export function isVerbose(): boolean {
  return shouldLog("verbose");
}

/**
 * Create a scoped logger for a specific component.
 */
export function createDevLogger(tag: string) {
  return {
    verbose: (message: string, ...args: unknown[]) => logVerbose(tag, message, ...args),
    info: (message: string, ...args: unknown[]) => logInfo(tag, message, ...args),
    warn: (message: string, ...args: unknown[]) => logWarn(tag, message, ...args),
    error: (message: string, ...args: unknown[]) => logError(tag, message, ...args),
    isVerbose: () => isVerbose(),
  };
}
