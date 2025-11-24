/**
 * Structured logging for request tracing and debugging.
 *
 * All AI-related operations are tagged with a request ID that allows
 * tracing through the entire request lifecycle: panel → main → API.
 */

export interface LogEntry {
  timestamp: string;
  level: "debug" | "info" | "warn" | "error";
  requestId: string;
  component: string;
  message: string;
  data?: unknown;
}

export class Logger {
  constructor(private component: string) {}

  private createEntry(
    level: LogEntry["level"],
    requestId: string,
    message: string,
    data?: unknown
  ): LogEntry {
    return {
      timestamp: new Date().toISOString(),
      level,
      requestId,
      component: this.component,
      message,
      data,
    };
  }

  private formatEntry(entry: LogEntry): string {
    const prefix = `[${entry.level.toUpperCase()}] [${entry.component}] [${entry.requestId}]`;
    const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : "";
    return `${prefix} ${entry.message}${dataStr}`;
  }

  debug(requestId: string, message: string, data?: unknown): void {
    const entry = this.createEntry("debug", requestId, message, data);
    console.debug(this.formatEntry(entry));
  }

  info(requestId: string, message: string, data?: unknown): void {
    const entry = this.createEntry("info", requestId, message, data);
    console.info(this.formatEntry(entry));
  }

  warn(requestId: string, message: string, data?: unknown): void {
    const entry = this.createEntry("warn", requestId, message, data);
    console.warn(this.formatEntry(entry));
  }

  error(requestId: string, message: string, data?: unknown, error?: Error): void {
    const entry = this.createEntry("error", requestId, message, data);
    const errorStr = error ? `\n${error.stack}` : "";
    console.error(this.formatEntry(entry) + errorStr);
  }
}

/**
 * Generate a unique request ID for tracing.
 */
export function generateRequestId(): string {
  return `req_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
