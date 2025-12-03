/**
 * Console Capture
 *
 * Creates a proxy console that captures all output while optionally
 * forwarding to the real console for debugging.
 */

import type { ConsoleEntry, ConsoleCapture } from "./types.js";

export interface ConsoleCaptureOptions {
  /** Forward captured output to real console */
  forward?: boolean;
}

/**
 * Create a console capture proxy that collects all console output.
 */
export function createConsoleCapture(
  options: ConsoleCaptureOptions = {}
): ConsoleCapture {
  const { forward = false } = options;
  const output: ConsoleEntry[] = [];

  // State for console methods
  const counters = new Map<string, number>();
  const timers = new Map<string, number>();
  let groupDepth = 0;

  const capture =
    (level: ConsoleEntry["level"]) =>
    (...args: unknown[]) => {
      // Add indentation for groups
      const indent = "  ".repeat(groupDepth);
      const indentedArgs = groupDepth > 0 ? [indent, ...args] : args;
      output.push({ level, args: indentedArgs, timestamp: Date.now() });
      if (forward) {
        // eslint-disable-next-line no-console
        console[level](...args);
      }
    };

  const proxy = {
    log: capture("log"),
    warn: capture("warn"),
    error: capture("error"),
    info: capture("info"),
    debug: capture("debug"),

    // Trace with stack trace
    trace: (...args: unknown[]) => {
      const stack = new Error().stack?.split("\n").slice(2).join("\n") ?? "";
      capture("debug")(...args, "\n" + stack);
    },

    // Object inspection
    dir: capture("log"),
    dirxml: capture("log"),
    table: (data: unknown, columns?: string[]) => {
      // Format table data, optionally filtering to specified columns
      if (Array.isArray(data) && data.length > 0) {
        const items = columns
          ? data.map((item) => {
              if (typeof item === "object" && item !== null) {
                const filtered: Record<string, unknown> = {};
                for (const col of columns) {
                  if (col in item) {
                    filtered[col] = (item as Record<string, unknown>)[col];
                  }
                }
                return filtered;
              }
              return item;
            })
          : data;
        capture("log")("Table:", items);
      } else if (typeof data === "object" && data !== null) {
        if (columns) {
          const filtered: Record<string, unknown> = {};
          for (const col of columns) {
            if (col in data) {
              filtered[col] = (data as Record<string, unknown>)[col];
            }
          }
          capture("log")("Table:", filtered);
        } else {
          capture("log")("Table:", data);
        }
      } else {
        capture("log")(data);
      }
    },

    // Counting
    count: (label = "default") => {
      const count = (counters.get(label) ?? 0) + 1;
      counters.set(label, count);
      capture("log")(`${label}: ${count}`);
    },
    countReset: (label = "default") => {
      counters.delete(label);
    },

    // Grouping
    group: (...args: unknown[]) => {
      if (args.length > 0) {
        capture("log")(...args);
      }
      groupDepth++;
    },
    groupCollapsed: (...args: unknown[]) => {
      if (args.length > 0) {
        capture("log")("[collapsed]", ...args);
      }
      groupDepth++;
    },
    groupEnd: () => {
      if (groupDepth > 0) {
        groupDepth--;
      }
    },

    // Timing
    time: (label = "default") => {
      if (timers.has(label)) {
        capture("warn")(`Timer '${label}' already exists`);
        return;
      }
      timers.set(label, performance.now());
    },
    timeLog: (label = "default", ...args: unknown[]) => {
      const start = timers.get(label);
      if (start === undefined) {
        capture("warn")(`Timer '${label}' does not exist`);
        return;
      }
      const elapsed = performance.now() - start;
      capture("log")(`${label}: ${elapsed.toFixed(3)}ms`, ...args);
    },
    timeEnd: (label = "default") => {
      const start = timers.get(label);
      if (start === undefined) {
        capture("warn")(`Timer '${label}' does not exist`);
        return;
      }
      const elapsed = performance.now() - start;
      timers.delete(label);
      capture("log")(`${label}: ${elapsed.toFixed(3)}ms`);
    },
    timeStamp: (label?: string) => {
      // TimeStamp is primarily for browser devtools, just log it
      capture("debug")(`TimeStamp: ${label ?? Date.now()}`);
    },

    // Clear (captured output, not the actual output array)
    clear: () => {
      capture("log")("Console was cleared");
    },

    // Assert
    assert: (condition?: boolean, ...args: unknown[]) => {
      if (!condition) {
        capture("error")("Assertion failed:", ...args);
      }
    },

    // Profiling (no-op, browser-specific)
    profile: () => {},
    profileEnd: () => {},
  } as Console;

  return {
    proxy,
    getOutput: () => [...output],
    clear: () => {
      output.length = 0;
      counters.clear();
      timers.clear();
      groupDepth = 0;
    },
  };
}
