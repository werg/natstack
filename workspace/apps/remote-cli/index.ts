import { createRpcClient, type RpcClient } from "@natstack/rpc";
import { NodeWsLike } from "@natstack/shared/shell/transport/nodeWsLike";
import { createConnectDeepLink } from "@natstack/shared/connect";
import { createServerWsTransport } from "@natstack/shared/shell/transport/serverWsTransport";
import { authMethods } from "@natstack/shared/serviceSchemas/auth";
import { workspaceMethods } from "@natstack/shared/serviceSchemas/workspace";
import { createTypedServiceClient } from "@natstack/shared/typedServiceClient";
import WebSocket from "ws";

export interface PairingInviteLike {
  connectUrl: string;
  code: string;
  deepLink?: string | null;
  expiresAt?: number;
}

export function formatPairingInvite(invite: PairingInviteLike): string {
  const deepLink = invite.deepLink ?? createConnectDeepLink(invite.connectUrl, invite.code);
  const expires = invite.expiresAt ? `\nExpires: ${new Date(invite.expiresAt).toISOString()}` : "";
  return [`Pairing code: ${invite.code}`, `Pair URL: ${deepLink}${expires}`].join("\n");
}

function printBootstrapSummary(): void {
  console.log(`App id: ${requiredEnv("NATSTACK_TERMINAL_APP_ID")}`);
  console.log(`Source: ${process.env["NATSTACK_TERMINAL_APP_SOURCE"] ?? "unknown"}`);
  console.log(`Build: ${process.env["NATSTACK_TERMINAL_APP_BUILD_KEY"] ?? "unknown"}`);
  console.log(
    `Effective version: ${process.env["NATSTACK_TERMINAL_APP_EFFECTIVE_VERSION"] || "unknown"}`
  );
  console.log(`Gateway: ${requiredEnv("NATSTACK_TERMINAL_APP_GATEWAY_URL")}`);
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function connect() {
  const appId = requiredEnv("NATSTACK_TERMINAL_APP_ID");
  const token = requiredEnv("NATSTACK_TERMINAL_APP_RPC_TOKEN");
  const connectionId = requiredEnv("NATSTACK_TERMINAL_APP_CONNECTION_ID");
  const transport = createServerWsTransport({
    selfId: appId,
    serverUrl: requiredEnv("NATSTACK_TERMINAL_APP_GATEWAY_URL"),
    connectionId,
    logPrefix: "RemoteCli",
    getAuthMessageFields: () => ({
      connectionId,
      clientLabel: "NatStack Remote CLI",
      clientPlatform: "desktop",
    }),
    translateEvent: (event, payload, deliver) => {
      deliver({
        type: "event",
        fromId: "main",
        event,
        payload,
      });
      if (event === "event:apps:lifecycle" || event === "apps:lifecycle") {
        console.log(`[apps:lifecycle] ${JSON.stringify(payload)}`);
      }
      return true;
    },
    adapter: {
      now: () => Date.now(),
      getAuthToken: async () => token,
      createSocket: (url) => new NodeWsLike(new WebSocket(url)),
    },
  });
  const rpc: RpcClient = createRpcClient({
    selfId: appId,
    callerKind: "app",
    transport,
  });

  transport.onStatusChange?.((status) => {
    if (status === "disconnected") process.exit(0);
  });
  await transport.connectAndWait();
  return { rpc, close: () => transport.close() };
}

export async function main(): Promise<void> {
  const { rpc, close } = await connect();
  const workspaceClient = createTypedServiceClient(
    "workspace",
    workspaceMethods,
    (service, method, args) => rpc.call("main", `${service}.${method}`, args)
  );
  const authClient = createTypedServiceClient("auth", authMethods, (service, method, args) =>
    rpc.call("main", `${service}.${method}`, args)
  );
  printBootstrapSummary();
  const workspace = await workspaceClient.getInfo();
  console.log(`Connected as ${requiredEnv("NATSTACK_TERMINAL_APP_ID")}`);
  console.log(`Workspace: ${workspace.config.id ?? "unknown"}`);

  const units = await workspaceClient.units.list();
  console.log(`Workspace units: ${units.length}`);
  for (const unit of units) {
    console.log(
      `- ${unit.kind} ${unit.name} ${unit.source} status=${unit.status} target=${unit.target ?? ""}`
    );
  }

  const command = process.env["NATSTACK_TERMINAL_APP_COMMAND"] ?? "invite";
  if (command === "status") return;
  if (command === "invite") {
    const invite = await authClient.createPairingInvite({ ttlMs: 10 * 60 * 1000 });
    console.log(formatPairingInvite(invite));
  }

  process.on("message", (message) => {
    if ((message as { type?: string })?.type === "shutdown") {
      close();
    }
  });
}

if (process.env["NATSTACK_TERMINAL_APP_GATEWAY_URL"]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exit(1);
  });
}
