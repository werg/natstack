import { createRpcBridge, type RpcBridge, type RpcMessage, type RpcTransport } from "@natstack/rpc";
import type { ApprovalDecision, PendingApproval } from "@natstack/shared/approvals";
import { RPC_METHODS } from "@natstack/shared/approvalContract";
import { getApprovalCategoryLabel, getApprovalCopy } from "@natstack/shared/approvalCopy";

type ShellTransportBridge = {
  send: (targetId: string, message: unknown) => Promise<void>;
  onMessage: (handler: (fromId: string, message: unknown) => void) => () => void;
};

const globals = globalThis as unknown as { __natstackTransport?: ShellTransportBridge };
const container = document.getElementById("approvals");
if (!container) throw new Error("Bootstrap approval container missing");
if (!globals.__natstackTransport) throw new Error("Bootstrap transport unavailable");
const approvalsContainer = container;
const output = document.getElementById("recovery-output") as HTMLPreElement | null;
const workspaceSelect = document.getElementById("workspace-select") as HTMLSelectElement | null;
const workspaceName = document.getElementById("workspace-name") as HTMLInputElement | null;

const transport: RpcTransport = {
  send: globals.__natstackTransport.send,
  onMessage: (_sourceId, handler) =>
    globals.__natstackTransport!.onMessage((fromId, message) => {
      if (fromId === "main") handler(message as RpcMessage);
    }),
  onAnyMessage: (handler) =>
    globals.__natstackTransport!.onMessage((fromId, message) =>
      handler(fromId, message as RpcMessage)
    ),
};

const rpc: RpcBridge = createRpcBridge({ selfId: "bootstrap", transport });
let pending: PendingApproval[] = [];
let rendering = false;

type WorkspaceEntry = { name: string; lastOpened?: number };
type WorkspaceUnitLogRecord = {
  timestamp: number;
  level: string;
  unitName: string;
  message: string;
};

function setOutput(message: string): void {
  if (!output) return;
  output.hidden = false;
  output.textContent = message;
}

function callerLabel(approval: PendingApproval): string {
  if (approval.callerKind === "system") return "Workspace";
  if (approval.callerKind === "app") return "App";
  if (approval.callerKind === "worker") return "Worker";
  if (approval.callerKind === "do") return "DO";
  return "Panel";
}

async function decide(approval: PendingApproval, decision: ApprovalDecision): Promise<void> {
  await rpc.call("main", RPC_METHODS.shellApproval.resolve, [approval.approvalId, decision]);
  pending = pending.filter((item) => item.approvalId !== approval.approvalId);
  render();
}

function render(): void {
  if (rendering) return;
  rendering = true;
  try {
    approvalsContainer.replaceChildren();
    if (pending.length === 0) {
      approvalsContainer.className = "empty";
      approvalsContainer.textContent =
        "No pending approvals. Waiting for the workspace shell app...";
      return;
    }
    approvalsContainer.className = "";
    for (const approval of pending) {
      const copy = getApprovalCopy(approval, callerLabel(approval));
      const card = document.createElement("article");
      card.className = "approval";

      const title = document.createElement("div");
      title.className = "title";
      title.textContent = copy.title;

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = `${getApprovalCategoryLabel(approval)}: ${copy.summary}`;

      const approve = document.createElement("button");
      approve.className = "primary";
      approve.textContent =
        approval.kind === "unit-batch"
          ? approval.trigger === "source-push"
            ? "Approve push"
            : approval.trigger === "management"
              ? "Approve"
              : "Approve all"
          : "Approve";
      approve.onclick = () => void decide(approval, "once");

      const deny = document.createElement("button");
      deny.className = "danger";
      deny.textContent = "Deny";
      deny.onclick = () => void decide(approval, "deny");

      card.append(title, meta, approve, deny);
      approvalsContainer.appendChild(card);
    }
  } finally {
    rendering = false;
  }
}

async function refresh(): Promise<void> {
  try {
    pending = await rpc.call<PendingApproval[]>("main", RPC_METHODS.shellApproval.listPending, []);
    render();
  } catch (err) {
    approvalsContainer.className = "empty";
    approvalsContainer.textContent = `Recovery UI could not reach the host: ${err instanceof Error ? err.message : String(err)}`;
  }
}

function workspaceEntryName(entry: unknown): string | null {
  const name = (entry as { name?: unknown })?.name;
  return typeof name === "string" && name.length > 0 ? name : null;
}

async function refreshWorkspaces(): Promise<void> {
  if (!workspaceSelect) return;
  try {
    const entries = await rpc.call<WorkspaceEntry[]>("main", "workspace.list", []);
    const active = await rpc.call<string>("main", "workspace.getActive", []);
    workspaceSelect.replaceChildren();
    for (const entry of entries) {
      const name = workspaceEntryName(entry);
      if (!name) continue;
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      option.selected = name === active;
      workspaceSelect.append(option);
    }
  } catch (err) {
    setOutput(`Workspace list unavailable: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function rollbackShell(): Promise<void> {
  try {
    const result = await rpc.call("main", "workspace.units.rollback", ["@workspace-apps/shell"]);
    setOutput(`Shell app rolled back.\n${JSON.stringify(result, null, 2)}`);
  } catch (err) {
    setOutput(`Shell rollback failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function showLogs(): Promise<void> {
  try {
    const rows = await rpc.call<WorkspaceUnitLogRecord[]>("main", "workspace.units.logs", [
      "@workspace-apps/shell",
      { limit: 100 },
    ]);
    if (rows.length === 0) {
      setOutput("No shell app logs are available.");
      return;
    }
    setOutput(
      rows
        .map((row) => {
          const when = new Date(row.timestamp).toISOString();
          return `${when} ${row.level.toUpperCase()} ${row.unitName}: ${row.message}`;
        })
        .join("\n")
    );
  } catch (err) {
    setOutput(`Log read failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function openWorkspacePath(): Promise<void> {
  try {
    await rpc.call("main", "app.openWorkspacePath", []);
    setOutput("Workspace path opened.");
  } catch (err) {
    setOutput(`Open workspace failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function switchWorkspace(): Promise<void> {
  const name = workspaceSelect?.value;
  if (!name) return;
  try {
    await rpc.call("main", "workspace.select", [name]);
    setOutput(`Switching to workspace ${name}...`);
  } catch (err) {
    setOutput(`Workspace switch failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function createWorkspace(): Promise<void> {
  const name = workspaceName?.value.trim();
  if (!name) return;
  try {
    await rpc.call("main", "workspace.create", [name]);
    setOutput(`Workspace ${name} created.`);
    workspaceName!.value = "";
    await refreshWorkspaces();
  } catch (err) {
    setOutput(`Workspace creation failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

document.getElementById("rollback-shell")?.addEventListener("click", () => void rollbackShell());
document.getElementById("show-logs")?.addEventListener("click", () => void showLogs());
document
  .getElementById("open-workspace")
  ?.addEventListener("click", () => void openWorkspacePath());
document
  .getElementById("switch-workspace")
  ?.addEventListener("click", () => void switchWorkspace());
document
  .getElementById("create-workspace")
  ?.addEventListener("click", () => void createWorkspace());

void refresh();
void refreshWorkspaces();
setInterval(() => void refresh(), 2000);
