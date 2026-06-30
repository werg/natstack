import {
  createRpcClient,
  type EnvelopeRpcTransport,
  type RpcClient,
  type RpcEnvelope,
} from "@natstack/rpc";
import type { PendingUnitBatchApproval } from "@natstack/shared/approvals";
import {
  approvalIds,
  formatCapabilities,
  launchCopy as getLaunchCopy,
  plural,
  samePendingApprovals,
  type BootstrapDecision,
  unitKindLabel,
  unitReviewRows,
  unitSourceLabel,
  unitSummaryChips,
} from "@natstack/shared/bootstrapLaunchGate";
import {
  HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT,
  isLaunchSessionEventFor,
  isLaunchSessionEventForTarget,
} from "@natstack/shared/hostTargetLaunchGate";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import { workspaceMethods } from "@natstack/shared/serviceSchemas/workspace";
import { eventsMethods } from "@natstack/shared/serviceSchemas/events";
import type { HostTargetLaunchSessionSnapshot } from "@natstack/shared/hostTargets";

type ShellTransportBridge = {
  send: (envelope: RpcEnvelope) => Promise<void>;
  onMessage: (handler: (envelope: RpcEnvelope) => void) => () => void;
};

type BootstrapBridge = {
  getState: () => Promise<unknown>;
  launchLocalWorkspace: (workspaceName: string) => Promise<unknown>;
  launchEphemeralWorkspace: () => Promise<unknown>;
  pairRemote: (payload: { link: string; label?: string }) => Promise<unknown>;
};

type BootstrapConnectionState = {
  mode: "choose-connection" | "starting" | "connected";
  localWorkspaces: Array<{ name: string; lastOpened: number }>;
  lastLocalWorkspaceName: string | null;
  isDev?: boolean;
  /** The natstack://connect deep link the app was opened with (auto-pair). */
  pendingPairLink?: string | null;
};

const globals = globalThis as unknown as {
  __natstackTransport?: ShellTransportBridge;
  __natstackBootstrap?: BootstrapBridge;
};
const container = document.getElementById("approvals");
if (!container) throw new Error("Bootstrap approval container missing");
const bootstrapTransport = globals.__natstackTransport;
const bootstrapApi = globals.__natstackBootstrap;
const approvalsContainer = container;
const launchCopy = document.getElementById("launch-copy");
const bootstrapMain = document.querySelector("main");
const bootstrapEyebrow = document.getElementById("bootstrap-eyebrow");
const bootstrapTitle = document.getElementById("bootstrap-title");

let rpc: RpcClient | null = null;

function createWorkspaceClient() {
  if (!bootstrapTransport) throw new Error("Bootstrap transport unavailable");
  const transport: EnvelopeRpcTransport = {
    send: (envelope) => bootstrapTransport.send(envelope),
    onMessage: (handler) => bootstrapTransport.onMessage(handler),
    status: () => "connected",
    ready: () => Promise.resolve(),
    onStatusChange: () => () => {},
  };

  const nextRpc = createRpcClient({ selfId: "bootstrap", callerKind: "app", transport });
  rpc = nextRpc;
  return createTypedServiceClient("workspace", workspaceMethods, (service, method, args) =>
    nextRpc.call("main", `${service}.${method}`, args)
  );
}

type WorkspaceClient = ReturnType<typeof createWorkspaceClient>;
let workspaceClient: WorkspaceClient | null = null;

function getWorkspaceClient(): WorkspaceClient {
  workspaceClient ??= createWorkspaceClient();
  return workspaceClient;
}

function getRpc(): RpcClient {
  getWorkspaceClient();
  if (!rpc) throw new Error("Bootstrap RPC unavailable");
  return rpc;
}

const eventsClient = createTypedServiceClient("events", eventsMethods, (service, method, args) =>
  getRpc().call("main", `${service}.${method}`, args)
);
const hostTarget = "electron";
const launchEventNames = [HOST_TARGET_LAUNCH_SESSION_CHANGED_EVENT] as const;
let pending: PendingUnitBatchApproval[] = [];
let rendering = false;
let refreshInFlight = false;
let refreshScheduled = false;
let launchSession: HostTargetLaunchSessionSnapshot | null = null;
let emptyLaunchText = "No workspace approval is pending. Starting the workspace...";
const decidingApprovalIds = new Set<string>();
const openReviewApprovalIds = new Set<string>();
let decisionError: string | null = null;

function scheduleRefresh(): void {
  if (refreshScheduled || refreshInFlight) return;
  refreshScheduled = true;
  window.setTimeout(() => {
    refreshScheduled = false;
    void refresh();
  }, 0);
}

function setPending(next: PendingUnitBatchApproval[]): boolean {
  if (samePendingApprovals(pending, next)) return false;
  pending = next;
  const pendingIds = approvalIds(next);
  for (const id of openReviewApprovalIds) {
    if (!pendingIds.has(id)) openReviewApprovalIds.delete(id);
  }
  return true;
}

function setLaunchSession(next: HostTargetLaunchSessionSnapshot): boolean {
  const previousSession = launchSession;
  launchSession = next;
  const pendingChanged = setPending(next.approvals);
  const text = launchSessionText(next);
  const textChanged = text !== emptyLaunchText;
  emptyLaunchText = text;
  return (
    pendingChanged ||
    textChanged ||
    previousSession?.sessionId !== next.sessionId ||
    previousSession?.status !== next.status ||
    previousSession?.currentPhase !== next.currentPhase ||
    previousSession?.detail !== next.detail
  );
}

async function decide(
  approval: PendingUnitBatchApproval,
  decision: BootstrapDecision
): Promise<void> {
  const sessionId = launchSession?.sessionId;
  if (!sessionId) return;
  if (decidingApprovalIds.has(approval.approvalId)) return;
  for (const item of pending) decidingApprovalIds.add(item.approvalId);
  decisionError = null;
  if (launchCopy) {
    launchCopy.textContent =
      decision === "deny"
        ? "Denying startup approval..."
        : "Approval recorded. Starting the workspace...";
  }
  render();
  try {
    const session = await getWorkspaceClient().hostTargets.resolveLaunchSessionApproval(
      sessionId,
      decision
    );
    setLaunchSession(session);
    await refresh();
  } catch (err) {
    decisionError = `Approval failed: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    decidingApprovalIds.clear();
    if (pending.some((item) => item.approvalId === approval.approvalId)) {
      render();
    }
  }
}

function appendDecisionButton(
  card: HTMLElement,
  approval: PendingUnitBatchApproval,
  label: string,
  decision: BootstrapDecision,
  className?: string
): void {
  const busy = decidingApprovalIds.has(approval.approvalId);
  const button = document.createElement("button");
  if (className) button.className = className;
  button.disabled = busy;
  if (busy && decision === "once") {
    button.setAttribute("aria-busy", "true");
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = "Starting...";
    button.append(spinner, text);
  } else {
    button.textContent = label;
  }
  button.onclick = () => void decide(approval, decision);
  card.append(button);
}

function appendUnitSummary(card: HTMLElement, approval: PendingUnitBatchApproval): void {
  const summary = document.createElement("div");
  summary.className = "unit-summary";
  const total = document.createElement("div");
  total.className = "unit-summary-total";
  total.textContent = plural(approval.units.length, "privileged unit");
  summary.append(total);

  const chips = document.createElement("div");
  chips.className = "unit-summary-chips";
  for (const label of unitSummaryChips(approval)) {
    const chip = document.createElement("span");
    chip.className = "unit-chip";
    chip.textContent = label;
    chips.append(chip);
  }
  summary.append(chips);
  card.append(summary);
}

function appendUnitReview(card: HTMLElement, approval: PendingUnitBatchApproval): void {
  const details = document.createElement("details");
  details.className = "unit-review";
  details.open = openReviewApprovalIds.has(approval.approvalId);
  details.addEventListener("toggle", () => {
    if (details.open) openReviewApprovalIds.add(approval.approvalId);
    else openReviewApprovalIds.delete(approval.approvalId);
  });
  const summary = document.createElement("summary");
  const title = document.createElement("span");
  title.textContent = "Review details";
  const hint = document.createElement("span");
  hint.className = "unit-review-hint";
  hint.textContent = "sources, versions, capabilities";
  summary.append(title, hint);
  details.append(summary);

  const list = document.createElement("ul");
  list.className = "unit-list";
  const rows = unitReviewRows(approval);
  approval.units.forEach((unit, index) => {
    const review = rows[index];
    if (review === undefined) return;
    const row = document.createElement("li");
    const text = document.createElement("div");
    const name = document.createElement("div");
    name.className = "unit-name";
    name.textContent = review.name;
    const meta = document.createElement("div");
    meta.className = "unit-meta";
    meta.textContent = unitSourceLabel(unit);
    const caps = document.createElement("div");
    caps.className = "unit-capabilities";
    caps.textContent = formatCapabilities(unit);
    const kind = document.createElement("div");
    kind.className = "unit-kind";
    kind.textContent = unitKindLabel(unit);
    text.append(name, meta, caps);
    row.append(text, kind);
    list.append(row);
  });
  details.append(list);
  card.append(details);
}

function appendApprovalActions(card: HTMLElement, approval: PendingUnitBatchApproval): void {
  const actions = document.createElement("div");
  actions.className = "toolbar";
  appendDecisionButton(actions, approval, "Trust and start", "once", "primary");
  appendDecisionButton(actions, approval, "Deny", "deny", "danger");
  card.append(actions);
  if (decidingApprovalIds.has(approval.approvalId)) {
    const status = document.createElement("div");
    status.className = "status";
    status.textContent = "Starting the workspace...";
    card.append(status);
  }
}

function appendLaunchTimeline(parent: HTMLElement, session: HostTargetLaunchSessionSnapshot): void {
  const list = document.createElement("ol");
  list.className = "launch-timeline";
  for (const phase of session.timeline) {
    const item = document.createElement("li");
    item.className = `launch-phase ${phase.state}`;
    const dot = document.createElement("span");
    dot.className = "launch-phase-dot";
    dot.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.className = "launch-phase-text";
    text.textContent = phase.detail ? `${phase.label}: ${phase.detail}` : phase.label;
    item.append(dot, text);
    list.append(item);
  }
  parent.append(list);
}

function launchSessionText(session: HostTargetLaunchSessionSnapshot): string {
  if (session.status === "ready") return "The workspace is approved and launching.";
  if (session.status === "denied") return session.message;
  if (session.status === "unavailable") {
    return [session.message, session.detail].filter(Boolean).join(" ");
  }
  if (session.status === "approval-required") {
    return decisionError ?? "Review the workspace code that wants to run before NatStack starts.";
  }
  return [session.message, session.detail].filter(Boolean).join(" ");
}

function render(): void {
  if (rendering) return;
  rendering = true;
  try {
    approvalsContainer.replaceChildren();
    if (pending.length === 0) {
      approvalsContainer.className = "launch-card empty";
      const message = document.createElement("div");
      message.className = "empty-message";
      message.textContent = emptyLaunchText;
      approvalsContainer.append(message);
      if (launchSession) appendLaunchTimeline(approvalsContainer, launchSession);
      if (launchCopy) {
        launchCopy.textContent = emptyLaunchText;
      }
      return;
    }
    approvalsContainer.className = "launch-card";
    if (launchCopy) {
      launchCopy.textContent =
        decisionError ?? "Review the workspace code that wants to run before NatStack starts.";
    }
    for (const approval of pending) {
      const copy = getLaunchCopy(approval);
      const card = document.createElement("article");
      card.className = "approval";

      const title = document.createElement("div");
      title.className = "title";
      title.textContent = copy.title;

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = copy.summary;

      card.append(title, meta);
      appendUnitSummary(card, approval);
      appendUnitReview(card, approval);
      appendApprovalActions(card, approval);
      approvalsContainer.appendChild(card);
    }
  } finally {
    rendering = false;
  }
}

async function refresh(): Promise<void> {
  if (refreshInFlight) return;
  refreshInFlight = true;
  try {
    const session =
      (launchSession
        ? await getWorkspaceClient().hostTargets.getLaunchSession(launchSession.sessionId)
        : null) ?? (await getWorkspaceClient().hostTargets.beginLaunch(hostTarget));
    if (setLaunchSession(session)) render();
  } catch (err) {
    approvalsContainer.className = "launch-card empty";
    approvalsContainer.textContent = `Launch gate could not reach the host: ${err instanceof Error ? err.message : String(err)}`;
  } finally {
    refreshInFlight = false;
  }
}

async function subscribeToLaunchEvents(): Promise<void> {
  for (const eventName of launchEventNames) {
    const rpcClient = getRpc();
    rpcClient.on(`event:${eventName}`, (payload) => {
      if (launchSession && isLaunchSessionEventFor(launchSession.sessionId, eventName, payload)) {
        if (setLaunchSession(payload)) render();
        return;
      }
      if (isLaunchSessionEventForTarget(hostTarget, eventName, payload)) scheduleRefresh();
    });
    await eventsClient.subscribe(eventName);
  }
}

let connectionState: BootstrapConnectionState | null = null;
let connectionBusyAction: string | null = null;
let connectionHandoff: { title: string; detail: string } | null = null;
let connectionError: string | null = null;
let pairLinkValue = "";
let localWorkspaceValue = "";
// Guards the one-shot auto-pair when the app was opened with a natstack://connect
// deep link — we pair automatically instead of waiting for a paste + click.
let autoPairTriggered = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBootstrapConnectionState(value: unknown): value is BootstrapConnectionState {
  if (!isRecord(value)) return false;
  if (
    value["mode"] !== "choose-connection" &&
    value["mode"] !== "starting" &&
    value["mode"] !== "connected"
  ) {
    return false;
  }
  return Array.isArray(value["localWorkspaces"]);
}

function formatLastOpened(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "Workspace";
  return `Last opened ${new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })}`;
}

function setBootstrapHeader(mode: "connection" | "approval"): void {
  if (mode === "connection") {
    bootstrapMain?.setAttribute("data-bootstrap-mode", "connection");
    if (bootstrapEyebrow) bootstrapEyebrow.textContent = "Connect";
    if (bootstrapTitle) bootstrapTitle.textContent = "Choose a server or workspace";
    if (launchCopy) {
      launchCopy.textContent =
        "Pair with an existing server, reconnect to a saved server, or launch a local workspace.";
    }
    return;
  }
  bootstrapMain?.setAttribute("data-bootstrap-mode", "approval");
  if (bootstrapEyebrow) bootstrapEyebrow.textContent = "Workspace Approval";
  if (bootstrapTitle) bootstrapTitle.textContent = "Do you trust the code in this workspace?";
}

function connectionButton(
  label: string,
  actionId: string,
  action: () => Promise<void>
): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = actionId === "pair" || actionId.startsWith("local") ? "primary" : "";
  button.disabled = connectionBusyAction !== null;
  if (connectionBusyAction === actionId) {
    button.setAttribute("aria-busy", "true");
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    const text = document.createElement("span");
    text.textContent = "Starting...";
    button.append(spinner, text);
  } else {
    button.textContent = label;
  }
  button.onclick = () => void runConnectionAction(actionId, action);
  return button;
}

function connectionHandoffFor(actionId: string): { title: string; detail: string } | null {
  if (actionId.startsWith("local:")) {
    return {
      title: "Launching local workspace",
      detail: "Preparing the selected workspace and startup approval gate...",
    };
  }
  if (actionId === "pair") {
    return {
      title: "Pairing server",
      detail: "Redeeming the pairing link over WebRTC and connecting...",
    };
  }
  return null;
}

function renderConnectionHandoff(): void {
  setBootstrapHeader("approval");
  approvalsContainer.className = "launch-card empty";
  approvalsContainer.replaceChildren();
  const message = document.createElement("div");
  message.className = "empty-message";
  message.textContent = connectionHandoff?.title ?? "Starting workspace";
  const detail = document.createElement("div");
  detail.className = "status";
  detail.textContent =
    connectionHandoff?.detail ?? "Preparing the selected workspace and startup approval gate...";
  approvalsContainer.append(message, detail);
  if (launchCopy) {
    launchCopy.textContent = detail.textContent;
  }
}

async function runConnectionAction(actionId: string, action: () => Promise<void>): Promise<void> {
  if (connectionBusyAction) return;
  connectionBusyAction = actionId;
  connectionHandoff = connectionHandoffFor(actionId);
  connectionError = null;
  if (connectionHandoff) {
    renderConnectionHandoff();
  } else if (connectionState) {
    renderConnectionChooser(connectionState);
  }
  try {
    await action();
    // No relaunch: the host resolves the choice and connects in THIS process and
    // window. Show the starting state and poll the bootstrap state until the
    // launch gate is ready (waitForConnectedBootstrapState drives the handoff).
    renderStartingWorkspace();
    waitForConnectedBootstrapState();
  } catch (err) {
    connectionError = err instanceof Error ? err.message : String(err);
    connectionBusyAction = null;
    connectionHandoff = null;
    if (connectionState) renderConnectionChooser(connectionState);
  }
}

function appendConnectionStatus(parent: HTMLElement): void {
  if (!connectionError) return;
  const status = document.createElement("div");
  status.className = "connection-error";
  status.textContent = connectionError;
  parent.append(status);
}

function appendPairRemote(parent: HTMLElement): void {
  const form = document.createElement("form");
  form.className = "connection-option connection-form";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = "Pair a server";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent =
    "Paste the natstack:// pairing link from the server. Pairing connects over WebRTC and opens the remote workspace in this window.";
  const fields = document.createElement("div");
  fields.className = "field-grid";

  const linkLabel = document.createElement("label");
  linkLabel.textContent = "Pairing link";
  const linkInput = document.createElement("input");
  linkInput.name = "link";
  linkInput.type = "text";
  linkInput.placeholder = "natstack://connect?room=...";
  linkInput.value = pairLinkValue;
  linkInput.autocomplete = "off";
  linkInput.oninput = () => {
    pairLinkValue = linkInput.value;
  };
  linkLabel.append(linkInput);

  fields.append(linkLabel);

  const actions = document.createElement("div");
  actions.className = "toolbar";
  actions.append(
    connectionButton("Pair server", "pair", async () => {
      if (!bootstrapApi) throw new Error("Bootstrap connection controls are unavailable");
      const link = pairLinkValue.trim();
      if (!link) throw new Error("Paste a natstack:// pairing link");
      const result = await bootstrapApi.pairRemote({ link });
      // On success the host accepts the pairing and connects in this process;
      // only a failed parse returns an { ok: false } result for us to surface.
      if (isRecord(result) && result["ok"] === false) {
        throw new Error(
          typeof result["message"] === "string"
            ? result["message"]
            : typeof result["error"] === "string"
              ? result["error"]
              : "Pairing failed"
        );
      }
    })
  );
  form.onsubmit = (event) => {
    event.preventDefault();
    const button = actions.querySelector("button");
    button?.click();
  };
  form.append(title, meta, fields, actions);
  parent.append(form);
}

function appendLocalWorkspaces(parent: HTMLElement, state: BootstrapConnectionState): void {
  const card = document.createElement("article");
  card.className = "connection-option";
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = "Local workspace";
  card.append(title);

  if (state.localWorkspaces.length > 0) {
    const list = document.createElement("div");
    list.className = "workspace-list";
    for (const workspace of state.localWorkspaces) {
      const row = document.createElement("div");
      row.className = "workspace-row";
      const text = document.createElement("div");
      const name = document.createElement("div");
      name.className = "workspace-name";
      name.textContent = workspace.name;
      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = formatLastOpened(workspace.lastOpened);
      text.append(name, meta);
      row.append(
        text,
        connectionButton("Launch", `local:${workspace.name}`, async () => {
          if (!bootstrapApi) throw new Error("Bootstrap connection controls are unavailable");
          await bootstrapApi.launchLocalWorkspace(workspace.name);
        })
      );
      list.append(row);
    }
    card.append(list);
  } else {
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = "No local workspaces found.";
    card.append(meta);
  }

  const form = document.createElement("form");
  form.className = "inline-form";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = state.lastLocalWorkspaceName ?? "default";
  input.value = localWorkspaceValue;
  input.autocomplete = "off";
  input.oninput = () => {
    localWorkspaceValue = input.value;
  };
  const launchLabel = state.localWorkspaces.length > 0 ? "Launch by name" : "Create and launch";
  const launchButton = connectionButton(launchLabel, "local:new", async () => {
    if (!bootstrapApi) throw new Error("Bootstrap connection controls are unavailable");
    const name = localWorkspaceValue.trim() || state.lastLocalWorkspaceName || "default";
    await bootstrapApi.launchLocalWorkspace(name);
  });
  form.onsubmit = (event) => {
    event.preventDefault();
    launchButton.click();
  };
  form.append(input, launchButton);
  card.append(form);

  if (state.isDev) {
    const ephemeralRow = document.createElement("div");
    ephemeralRow.className = "workspace-row";
    const ephemeralText = document.createElement("div");
    const ephemeralName = document.createElement("div");
    ephemeralName.className = "workspace-name";
    ephemeralName.textContent = "Ephemeral workspace";
    const ephemeralMeta = document.createElement("div");
    ephemeralMeta.className = "meta";
    ephemeralMeta.textContent = "Fresh and disposed at exit.";
    ephemeralText.append(ephemeralName, ephemeralMeta);
    ephemeralRow.append(
      ephemeralText,
      connectionButton("New", "local:ephemeral", async () => {
        if (!bootstrapApi) throw new Error("Bootstrap connection controls are unavailable");
        await bootstrapApi.launchEphemeralWorkspace();
      })
    );
    card.append(ephemeralRow);
  }

  parent.append(card);
}

function renderConnectionChooser(state: BootstrapConnectionState): void {
  connectionHandoff = null;
  connectionState = state;
  setBootstrapHeader("connection");
  approvalsContainer.className = "connection-grid";
  approvalsContainer.replaceChildren();
  appendConnectionStatus(approvalsContainer);
  appendPairRemote(approvalsContainer);
  appendLocalWorkspaces(approvalsContainer, state);
  // Opened via a natstack://connect deep link ⇒ pair automatically (one-shot).
  // The user already expressed intent by opening the link; on success the host
  // connects in this process and the launch gate proceeds in this window.
  if (state.pendingPairLink && !autoPairTriggered && !connectionBusyAction) {
    autoPairTriggered = true;
    const link = state.pendingPairLink;
    pairLinkValue = link;
    void runConnectionAction("pair", async () => {
      if (!bootstrapApi) throw new Error("Bootstrap connection controls are unavailable");
      const result = await bootstrapApi.pairRemote({ link });
      if (isRecord(result) && result["ok"] === false) {
        throw new Error(
          typeof result["message"] === "string"
            ? result["message"]
            : typeof result["error"] === "string"
              ? result["error"]
              : "Pairing failed"
        );
      }
    });
  }
}

function renderStartingWorkspace(): void {
  connectionHandoff = {
    title: "Starting workspace",
    detail: "Preparing the selected workspace and startup approval gate...",
  };
  renderConnectionHandoff();
}

function waitForConnectedBootstrapState(): void {
  window.setTimeout(async () => {
    const state = bootstrapApi ? await bootstrapApi.getState().catch(() => null) : null;
    if (!isBootstrapConnectionState(state)) {
      waitForConnectedBootstrapState();
      return;
    }
    if (state.mode === "connected") {
      await startLaunchGate();
      return;
    }
    if (state.mode === "choose-connection") {
      renderConnectionChooser(state);
      return;
    }
    renderStartingWorkspace();
    waitForConnectedBootstrapState();
  }, 500);
}

async function startLaunchGate(): Promise<void> {
  setBootstrapHeader("approval");
  await subscribeToLaunchEvents().catch((err) => {
    approvalsContainer.className = "launch-card empty";
    approvalsContainer.textContent = `Launch gate could not subscribe to host events: ${
      err instanceof Error ? err.message : String(err)
    }`;
  });
  await refresh();
}

async function init(): Promise<void> {
  const state = bootstrapApi ? await bootstrapApi.getState().catch(() => null) : null;
  if (isBootstrapConnectionState(state) && state.mode === "choose-connection") {
    renderConnectionChooser(state);
    return;
  }
  if (isBootstrapConnectionState(state) && state.mode === "starting") {
    renderStartingWorkspace();
    waitForConnectedBootstrapState();
    return;
  }
  await startLaunchGate();
}

void init().catch((err) => {
  approvalsContainer.className = "launch-card empty";
  approvalsContainer.textContent = err instanceof Error ? err.message : String(err);
});
