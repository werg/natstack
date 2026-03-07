import type { ViewManager } from "./viewManager.js";
import { createDevLogger } from "../shared/devLog.js";

const log = createDevLogger("MemoryMonitor");

const DEFAULT_LOG_INTERVAL_MS = 60_000;

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let monitorStarted = false;
let _viewManager: ViewManager | null = null;

export function setMemoryMonitorViewManager(vm: ViewManager | null): void {
  _viewManager = vm;
}

type MemorySnapshotOptions = {
  reason?: string;
  thresholdMb?: number;
};

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function truncate(value: string, max = 60): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export async function logMemorySnapshot(options: MemorySnapshotOptions = {}): Promise<void> {
  if (!_viewManager) return;
  const vm = _viewManager;
  const viewIds = vm.getViewIds();
  if (viewIds.length === 0) return;

  let metrics: Electron.ProcessMetric[];
  try {
    const { app } = require("electron");
    metrics = app.getAppMetrics();
  } catch {
    return; // No metrics available outside Electron
  }
  const metricsByPid = new Map(metrics.map((metric) => [metric.pid, metric]));

  const entries = await Promise.all(
    viewIds.map(async (id) => {
      const contents = vm.getWebContents(id);
      if (!contents) return null;

      const pid = contents.getOSProcessId();
      const metric = metricsByPid.get(pid);
      if (!metric) return null;

      const memKb = metric.memory.workingSetSize;
      const memMb = memKb / 1024;

      if (options.thresholdMb && memMb < options.thresholdMb) return null;

      return {
        id: truncate(id, 40),
        mb: Math.round(memMb * 10) / 10,
        url: truncate(contents.getURL() || "(empty)", 80),
      };
    }),
  );

  const nonNull = entries.filter(Boolean);
  if (nonNull.length === 0) return;

  const sortedByMem = nonNull.sort((a, b) => (b?.mb ?? 0) - (a?.mb ?? 0));

  const mainMetric = metrics.find((m) => m.type === "Browser");
  const mainMb = mainMetric ? Math.round(mainMetric.memory.workingSetSize / 1024 * 10) / 10 : "?";

  const reason = options.reason ? `[${options.reason}]` : "";
  const lines = sortedByMem.map(
    (e) => `  ${e!.mb.toString().padStart(7)}MB  ${e!.id.padEnd(42)} ${e!.url}`,
  );
  log.info(
    `Memory snapshot ${reason}\n  Main: ${mainMb}MB\n${lines.join("\n")}`,
  );
}

export function startMemoryMonitor(): void {
  if (monitorStarted) return;
  monitorStarted = true;

  const intervalMs = parsePositiveInt(process.env["NATSTACK_MEMORY_LOG_MS"]) ?? 0;
  const logOnce = process.env["NATSTACK_MEMORY_LOG_ONCE"] === "1";
  const thresholdMb = parsePositiveInt(process.env["NATSTACK_MEMORY_LOG_THRESHOLD_MB"]) ?? 0;

  if (intervalMs <= 0 && !logOnce) return;

  if (logOnce) {
    void logMemorySnapshot({ reason: "startup", thresholdMb });
    return;
  }

  const effectiveInterval = intervalMs > 0 ? intervalMs : DEFAULT_LOG_INTERVAL_MS;
  monitorTimer = setInterval(() => {
    void logMemorySnapshot({ reason: "interval", thresholdMb });
  }, effectiveInterval);

  void logMemorySnapshot({ reason: "startup", thresholdMb });
}

export function stopMemoryMonitor(): void {
  if (monitorTimer) {
    clearInterval(monitorTimer);
    monitorTimer = null;
  }
  monitorStarted = false;
}
