import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  formatLaunchGateForTerminal,
  targetLabel,
  type BootstrapDecision,
} from "@natstack/shared/bootstrapLaunchGate";
import { createRpcClient } from "@natstack/rpc";
import { NodeWsLike } from "@natstack/shared/shell/transport/nodeWsLike";
import { createServerWsTransport } from "@natstack/shared/shell/transport/serverWsTransport";
import { WebSocket } from "ws";
import {
  HOST_TARGET_LAUNCH_SESSION_WAKE_EVENTS,
  isLaunchSessionEventForTarget,
} from "@natstack/shared/hostTargetLaunchGate";
import type {
  HostTarget,
  HostTargetLaunchResult,
  HostTargetLaunchSessionSnapshot,
} from "@natstack/shared/hostTargets";
import { workspaceMethods } from "@natstack/shared/serviceSchemas/workspace";
import { typedClient } from "./typedClients.js";
import { refreshShell, RpcClient, type DeviceCredential } from "./rpcClient.js";

export interface TerminalLaunchGateOptions {
  target?: HostTarget;
  yes?: boolean;
  json?: boolean;
}

export interface TerminalLaunchGateResult {
  target: HostTarget;
  status: HostTargetLaunchResult["status"] | "denied";
  approvalsResolved: number;
  launch?: HostTargetLaunchResult;
}

export async function runTerminalLaunchGate(
  creds: Pick<DeviceCredential, "url" | "deviceId" | "refreshToken">,
  options: TerminalLaunchGateOptions = {}
): Promise<TerminalLaunchGateResult> {
  const target = options.target ?? "terminal";
  const rpc = new RpcClient(creds);
  const workspace = typedClient("workspace", workspaceMethods, rpc);
  const eventsRef: { current: TerminalLaunchEventClient | null } = { current: null };

  try {
    let session = await workspace.hostTargets.beginLaunch(target);
    let lastProgress = "";
    for (;;) {
      if (session.status === "ready") {
        return {
          target,
          status: "ready",
          approvalsResolved: session.approvalsResolved,
          launch: session.launch,
        };
      }
      if (session.status === "unavailable") {
        return {
          target,
          status: "unavailable",
          approvalsResolved: session.approvalsResolved,
          launch: session.launch,
        };
      }
      if (session.status === "denied") {
        return { target, status: "denied", approvalsResolved: session.approvalsResolved };
      }
      if (session.status === "approval-required") {
        if (!options.json) {
          output.write(`${formatLaunchGateForTerminal(session.approvals, target)}\n\n`);
        }
        const decision = await getDecision(target, options);
        session = await workspace.hostTargets.resolveLaunchSessionApproval(
          session.sessionId,
          decision
        );
        lastProgress = "";
        continue;
      }
      if (session.status === "preparing" || session.status === "starting") {
        if (!options.json) {
          const progress = formatLaunchSessionProgress(session);
          if (progress && progress !== lastProgress) {
            output.write(`${progress}\n`);
            lastProgress = progress;
          }
        }
        eventsRef.current ??= await createTerminalLaunchEventClient(creds, target);
        const update = await eventsRef.current.waitForLaunchSessionChange(
          session.sessionId,
          120_000
        );
        if (update) {
          session = update;
          continue;
        }
        const refreshed = await workspace.hostTargets.getLaunchSession(session.sessionId);
        if (refreshed) {
          session = refreshed;
          continue;
        }
        return {
          target,
          status: "preparing",
          approvalsResolved: session.approvalsResolved,
          launch: session.launch,
        };
      }
    }
  } finally {
    await eventsRef.current?.close();
  }
}

async function getDecision(
  target: HostTarget,
  options: TerminalLaunchGateOptions
): Promise<BootstrapDecision> {
  if (options.yes) return "once";
  if (!input.isTTY || !output.isTTY) {
    throw new Error(
      `${targetLabel(target)} startup approval requires an interactive terminal. ` +
        "Re-run with --yes to approve once non-interactively."
    );
  }
  const rl = readline.createInterface({ input, output });
  try {
    for (;;) {
      const answer = (await rl.question("Trust and start? [y/N] ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") return "once";
      if (answer === "" || answer === "n" || answer === "no") return "deny";
      output.write("Please answer y or n.\n");
    }
  } finally {
    rl.close();
  }
}

interface TerminalLaunchEventClient {
  waitForLaunchSessionChange(
    sessionId: string,
    timeoutMs: number
  ): Promise<HostTargetLaunchSessionSnapshot | null>;
  close(): Promise<void>;
}

interface EventServerClient {
  call(service: string, method: string, args: unknown[]): Promise<unknown>;
  close(): Promise<void>;
}

async function createEventServerClient(
  shellToken: string,
  opts: {
    serverUrl: string;
    refreshAuthToken: () => Promise<string>;
    onServerEvent: (event: string, payload: unknown) => void;
    onRecovery: () => void | Promise<void>;
  }
): Promise<EventServerClient> {
  let activeToken = shellToken;
  const transport = createServerWsTransport({
    selfId: "admin",
    serverUrl: opts.serverUrl,
    reconnect: true,
    logPrefix: "TerminalLaunchGate",
    onServerEvent: opts.onServerEvent,
    onRecovery: opts.onRecovery,
    adapter: {
      now: () => Date.now(),
      getAuthToken: async () => activeToken,
      refreshAuthToken: async () => {
        activeToken = await opts.refreshAuthToken();
        return activeToken;
      },
      createSocket: (url) => new NodeWsLike(new WebSocket(url)),
    },
  });
  await transport.connectAndWait();
  const rpc = createRpcClient({ selfId: "admin", callerKind: "server", transport });
  return {
    call(service, method, args) {
      return rpc.call("main", `${service}.${method}`, args);
    },
    close() {
      return transport.close();
    },
  };
}

async function createTerminalLaunchEventClient(
  creds: Pick<DeviceCredential, "url" | "deviceId" | "refreshToken">,
  target: HostTarget
): Promise<TerminalLaunchEventClient> {
  const eventNames = HOST_TARGET_LAUNCH_SESSION_WAKE_EVENTS;
  const waiters = new Set<() => void>();
  let lastSession: HostTargetLaunchSessionSnapshot | null = null;
  let revision = 0;
  let observedRevision = 0;
  const notify = () => {
    revision += 1;
    for (const waiter of [...waiters]) waiter();
  };
  const subscribeAll = async (nextClient: EventServerClient | null) => {
    if (!nextClient) return;
    await Promise.all(eventNames.map((event) => nextClient.call("events", "subscribe", [event])));
  };
  const shellToken = (await refreshShell(creds)).shellToken;
  let client: EventServerClient | null = null;
  client = await createEventServerClient(shellToken, {
    serverUrl: creds.url,
    refreshAuthToken: async () => (await refreshShell(creds)).shellToken,
    onServerEvent: (event, payload) => {
      if (isLaunchSessionEventForTarget(target, event, payload)) {
        lastSession = payload;
        notify();
      }
    },
    onRecovery: async () => {
      await subscribeAll(client);
    },
  });
  await subscribeAll(client);
  return {
    waitForLaunchSessionChange(sessionId, timeoutMs) {
      if (lastSession?.sessionId === sessionId && revision !== observedRevision) {
        observedRevision = revision;
        return Promise.resolve(lastSession);
      }
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          waiters.delete(done);
          resolve(null);
        }, timeoutMs);
        const done = () => {
          observedRevision = revision;
          clearTimeout(timer);
          waiters.delete(done);
          resolve(lastSession?.sessionId === sessionId ? lastSession : null);
        };
        waiters.add(done);
      });
    },
    close() {
      return client?.close() ?? Promise.resolve();
    },
  };
}

function formatLaunchSessionProgress(session: HostTargetLaunchSessionSnapshot): string {
  const active = session.timeline.find((phase) => phase.state === "active");
  return [session.message, active?.detail, session.detail].filter(Boolean).join("\n");
}
