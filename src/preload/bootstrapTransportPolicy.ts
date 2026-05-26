const BOOTSTRAP_RPC_METHODS = new Set([
  "shellApproval.resolve",
  "shellApproval.listPending",
  "workspace.list",
  "workspace.getActive",
  "workspace.create",
  "workspace.select",
  "workspace.units.reseedCanonicalShell",
  "workspace.units.logs",
  "app.openWorkspacePath",
]);

export function assertBootstrapRpcMessageAllowed(targetId: string, message: unknown): void {
  if (targetId !== "main") {
    throw new Error("Bootstrap recovery UI can only call the host RPC endpoint");
  }
  if (!isRpcRequest(message)) {
    throw new Error("Bootstrap recovery UI can only send RPC requests");
  }
  if (!BOOTSTRAP_RPC_METHODS.has(message.method)) {
    throw new Error(`Bootstrap recovery UI is not allowed to call ${message.method}`);
  }
}

function isRpcRequest(value: unknown): value is { type: "request"; method: string } {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { type?: unknown }).type === "request" &&
    typeof (value as { method?: unknown }).method === "string"
  );
}
