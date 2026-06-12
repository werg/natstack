/**
 * Testkit Driver — a Durable Object that performs CDP operations a panel
 * caller is not permitted to do directly (panelCdp policy restricts panel
 * callers to browser-panel targets; worker/DO callers are exempt, subject to
 * the panel-access approval flow).
 *
 * The @workspace/testkit panel SDK routes workspace-panel automation and
 * profiling through this DO (see testkit's driver.ts). Sessions are held in
 * instance memory: they die if the DO hibernates or restarts, which is fine
 * for test-scoped use — callers reopen on "unknown session" errors.
 */
import { DurableObjectBase } from "@workspace/runtime/worker";
import { CdpConnection } from "@workspace/cdp-client";
import {
  cpuProfileRef,
  persistProfile,
  profilePath,
  type ProfileRef,
  type V8Profile,
} from "@workspace/testkit/profiling";

interface CdpEndpoint {
  wsEndpoint: string;
  token?: string;
}

interface DriverSession {
  connection: CdpConnection;
  panelId: string;
  events: Array<{ seq: number; method: string; params: unknown }>;
  nextEventSeq: number;
  subscriptions: Map<string, () => void>;
  openedAt: number;
}

const MAX_BUFFERED_EVENTS = 2_000;
const SESSION_IDLE_LIMIT_MS = 10 * 60_000;

export class TestkitDriverDO extends DurableObjectBase {
  private readonly sessions = new Map<string, DriverSession>();
  private sessionCounter = 0;

  protected createTables(): void {
    // Stateless by design — all session state is in-memory and test-scoped.
  }

  private async connectToPanel(panelId: string): Promise<CdpConnection> {
    const endpoint = await this.rpc.call<CdpEndpoint>("main", "panelCdp.getCdpEndpoint", [panelId]);
    return CdpConnection.connect(endpoint.wsEndpoint, endpoint.token);
  }

  private session(sessionId: string): DriverSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`unknown CDP session ${sessionId} (the driver may have restarted — reopen)`);
    }
    return session;
  }

  private reapIdleSessions(): void {
    const cutoff = Date.now() - SESSION_IDLE_LIMIT_MS;
    for (const [id, session] of this.sessions) {
      if (session.openedAt < cutoff) {
        session.connection.close();
        this.sessions.delete(id);
      }
    }
  }

  /** Open a raw CDP session to a panel. Approval-gated via panelCdp. */
  async cdpOpen(panelId: string): Promise<{ sessionId: string }> {
    this.reapIdleSessions();
    const connection = await this.connectToPanel(panelId);
    const sessionId = `cdp-${++this.sessionCounter}-${Date.now()}`;
    this.sessions.set(sessionId, {
      connection,
      panelId,
      events: [],
      nextEventSeq: 1,
      subscriptions: new Map(),
      openedAt: Date.now(),
    });
    return { sessionId };
  }

  async cdpSend(
    sessionId: string,
    method: string,
    params?: Record<string, unknown>
  ): Promise<unknown> {
    const session = this.session(sessionId);
    session.openedAt = Date.now();
    return session.connection.send(method, params);
  }

  /** Start buffering a CDP event stream for cursor-based draining. */
  async cdpSubscribe(sessionId: string, eventMethod: string): Promise<void> {
    const session = this.session(sessionId);
    if (session.subscriptions.has(eventMethod)) return;
    const unsubscribe = session.connection.on(eventMethod, (params) => {
      session.events.push({ seq: session.nextEventSeq++, method: eventMethod, params });
      if (session.events.length > MAX_BUFFERED_EVENTS) {
        session.events.splice(0, session.events.length - MAX_BUFFERED_EVENTS);
      }
    });
    session.subscriptions.set(eventMethod, unsubscribe);
  }

  /** Drain buffered events after `cursor`; returns the new cursor. */
  async cdpDrainEvents(
    sessionId: string,
    cursor = 0
  ): Promise<{ events: Array<{ seq: number; method: string; params: unknown }>; cursor: number }> {
    const session = this.session(sessionId);
    const events = session.events.filter((event) => event.seq > cursor);
    return { events, cursor: events.length > 0 ? events[events.length - 1]!.seq : cursor };
  }

  async cdpClose(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    for (const unsubscribe of session.subscriptions.values()) unsubscribe();
    session.connection.close();
    this.sessions.delete(sessionId);
  }

  /**
   * Profile a panel for a fixed duration; artifact goes to context fs, only
   * the compact ref returns. For profile-around-an-action flows the caller
   * uses cdpOpen + Profiler.* commands via cdpSend instead.
   */
  async profilePanel(
    panelId: string,
    opts?: { durationMs?: number; samplingIntervalUs?: number }
  ): Promise<ProfileRef> {
    const connection = await this.connectToPanel(panelId);
    const startedAt = Date.now();
    try {
      await connection.send("Profiler.enable");
      if (opts?.samplingIntervalUs) {
        await connection.send("Profiler.setSamplingInterval", { interval: opts.samplingIntervalUs });
      }
      await connection.send("Profiler.start");
      await new Promise((resolve) => setTimeout(resolve, opts?.durationMs ?? 5_000));
      const result = (await connection.send("Profiler.stop")) as { profile: V8Profile };
      return await persistProfile(
        this.fs,
        cpuProfileRef(`panel:${panelId}`, startedAt, result.profile),
        JSON.stringify(result.profile)
      );
    } finally {
      connection.close();
    }
  }

  /** Heap snapshot of a panel; artifact to context fs, compact ref returned. */
  async heapSnapshot(panelId: string): Promise<ProfileRef> {
    const connection = await this.connectToPanel(panelId);
    const startedAt = Date.now();
    try {
      const chunks: string[] = [];
      const unsubscribe = connection.on("HeapProfiler.addHeapSnapshotChunk", (params) => {
        chunks.push((params as { chunk: string }).chunk);
      });
      await connection.send("HeapProfiler.enable");
      await connection.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
      unsubscribe();
      const data = chunks.join("");
      const ref: ProfileRef = {
        path: profilePath(`panel:${panelId}`, "heapsnapshot", startedAt),
        kind: "heapsnapshot",
        target: `panel:${panelId}`,
        startedAt,
        durationMs: Date.now() - startedAt,
        summary: {},
      };
      return await persistProfile(this.fs, ref, data);
    } finally {
      connection.close();
    }
  }

  /** Liveness probe for ensureWorker-style readiness checks. */
  async ping(): Promise<{ ok: true; sessions: number }> {
    return { ok: true, sessions: this.sessions.size };
  }
}

export default {
  async fetch(_request: Request) {
    return new Response(
      "Testkit driver Durable Object.\nUsed by @workspace/testkit for workspace-panel CDP automation and profiling.\nResolve via workers.resolveService(\"natstack.testkit-driver.v1\").",
      { headers: { "Content-Type": "text/plain" } }
    );
  },
};
