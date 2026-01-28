import { app } from "electron";
import { getViewManager, isViewManagerInitialized } from "./viewManager.js";

const DEFAULT_LOG_INTERVAL_MS = 60_000;

let monitorTimer: ReturnType<typeof setInterval> | null = null;
let monitorStarted = false;

type MemorySnapshotOptions = {
  reason?: string;
  thresholdMb?: number;
};

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function formatMb(kb: number | null | undefined): string {
  if (!kb || !Number.isFinite(kb)) return "n/a";
  return `${(kb / 1024).toFixed(1)} MB`;
}

function truncate(value: string, max = 96): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

export async function logMemorySnapshot(options: MemorySnapshotOptions = {}): Promise<void> {
  if (!isViewManagerInitialized()) return;
  const vm = getViewManager();
  const viewIds = vm.getViewIds();
  if (viewIds.length === 0) return;

  const metrics = app.getAppMetrics();
  const metricsByPid = new Map(metrics.map((metric) => [metric.pid, metric]));

  const entries = await Promise.all(
    viewIds.map(async (id) => {
      const contents = vm.getWebContents(id);
      if (!contents) return null;
      const info = await contents.getProcessMemoryInfo().catch(() => null);
      const pid = contents.getOSProcessId();
      const viewInfo = vm.getViewInfo(id);
      return {
        id,
        pid,
        type: viewInfo?.type ?? "unknown",
        visible: vm.isViewVisible(id),
        url: contents.getURL(),
        info,
        metric: metricsByPid.get(pid),
      };
    })
  );

  const filtered = entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
  if (filtered.length === 0) return;

  const thresholdMb = options.thresholdMb ?? 0;
  if (thresholdMb > 0) {
    const anyOver = filtered.some((entry) => {
      const resident = entry.info?.residentSet ?? 0;
      return resident / 1024 >= thresholdMb;
    });
    if (!anyOver) return;
  }

  const reason = options.reason ?? "snapshot";
  const timestamp = new Date().toISOString();
  console.log(`[Memory] Snapshot (${reason}) @ ${timestamp}`);

  const sorted = filtered.slice().sort((a, b) => {
    const aResident = a.info?.residentSet ?? 0;
    const bResident = b.info?.residentSet ?? 0;
    return bResident - aResident;
  });

  for (const entry of sorted) {
    const resident = formatMb(entry.info?.residentSet ?? null);
    const privateMb = formatMb(entry.info?.private ?? null);
    const sharedMb = formatMb(entry.info?.shared ?? null);
    const workingSet = formatMb(entry.metric?.memory.workingSetSize ?? null);
    const url = entry.url ? truncate(entry.url) : "about:blank";
    console.log(
      `[Memory] view=${entry.id} type=${entry.type} visible=${entry.visible} pid=${entry.pid}` +
        ` resident=${resident} private=${privateMb} shared=${sharedMb} workingSet=${workingSet}` +
        ` url=${url}`
    );
  }
}

export function startMemoryMonitor(): void {
  if (monitorStarted) return;
  monitorStarted = true;

  const intervalMs = parsePositiveInt(process.env.NATSTACK_MEMORY_LOG_MS) ?? 0;
  const logOnce = process.env.NATSTACK_MEMORY_LOG_ONCE === "1";
  const thresholdMb = parsePositiveInt(process.env.NATSTACK_MEMORY_LOG_THRESHOLD_MB) ?? 0;

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
