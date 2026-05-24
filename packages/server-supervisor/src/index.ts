import * as path from "node:path";
import { resolveOperatorAuth } from "./operatorAuth.js";
import { SupervisorGateway } from "./supervisorGateway.js";
import { WorkspaceSupervisor } from "./workspaceSupervisor.js";

interface CliArgs {
  port?: number;
  bindHost?: string;
  host?: string;
  protocol?: "http" | "https";
  publicUrl?: string;
  tlsCert?: string;
  tlsKey?: string;
  maxWorkspaces?: number;
  idleTimeoutMs?: number;
  operatorToken?: string;
  allowCreate?: boolean;
  exposeWorkspace?: string[];
  requireAuthToColdStart?: boolean;
  appRoot?: string;
  serverBundlePath?: string;
  help?: boolean;
}

function printHelp(): void {
  console.log(`
natstack-supervisor — Multi-workspace NatStack supervisor

Usage:
  node dist/supervisor.mjs [options]

Options:
  --port <port>                  Public supervisor port (default: 8099)
  --bind-host <addr>             Bind address (default: 127.0.0.1)
  --host <hostname>              Public hostname fallback (default: localhost)
  --protocol <http|https>        Public protocol fallback (default: http)
  --public-url <url>             Canonical public URL, including optional base path
  --tls-cert <path>              TLS certificate file
  --tls-key <path>               TLS private key file
  --max-workspaces <n>           Max concurrently active backend workspaces (default: 5)
  --idle-timeout <ms>            Idle backend teardown timeout in ms (default: 1800000)
  --operator-token <token>       Supervisor operator bearer token
  --allow-create                 Enable operator-authenticated workspace creation
  --expose-workspace <name[,..]> Restrict tenant cold starts to listed workspaces
  --require-auth-to-cold-start   Require operator auth before spawning a stopped backend
  --app-root <path>              Application root for workspace templates (default: cwd)
  --server-bundle <path>         Backend server bundle path (default: dist/server.mjs)
  --help                         Show this help message
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {};
  const bools = new Set(["allow-create", "require-auth-to-cold-start", "help"]);
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw?.startsWith("--")) throw new Error(`Unknown argument: ${raw}`);
    const eq = raw.indexOf("=");
    const key = eq === -1 ? raw.slice(2) : raw.slice(2, eq);
    let value = eq === -1 ? undefined : raw.slice(eq + 1);
    if (!bools.has(key) && value === undefined) {
      value = argv[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    }
    switch (key) {
      case "port":
        args.port = parsePort(value, "--port");
        break;
      case "bind-host":
        args.bindHost = value;
        break;
      case "host":
        args.host = value;
        break;
      case "protocol":
        if (value !== "http" && value !== "https")
          throw new Error("--protocol must be http or https");
        args.protocol = value;
        break;
      case "public-url":
        args.publicUrl = value;
        break;
      case "tls-cert":
        args.tlsCert = value;
        break;
      case "tls-key":
        args.tlsKey = value;
        break;
      case "max-workspaces":
        args.maxWorkspaces = parsePositiveInt(value, "--max-workspaces");
        break;
      case "idle-timeout":
        args.idleTimeoutMs = parseNonNegativeInt(value, "--idle-timeout");
        break;
      case "operator-token":
        args.operatorToken = value;
        break;
      case "allow-create":
        args.allowCreate = true;
        break;
      case "expose-workspace":
        args.exposeWorkspace = [...(args.exposeWorkspace ?? []), ...parseNameList(value)];
        break;
      case "require-auth-to-cold-start":
        args.requireAuthToColdStart = true;
        break;
      case "app-root":
        args.appRoot = value;
        break;
      case "server-bundle":
        args.serverBundlePath = value;
        break;
      case "help":
        args.help = true;
        break;
      default:
        throw new Error(`Unknown flag: --${key}`);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }
  if (args.tlsCert && !args.tlsKey) throw new Error("--tls-cert requires --tls-key");
  if (args.tlsKey && !args.tlsCert) throw new Error("--tls-key requires --tls-cert");

  const port = args.port ?? numberEnv("NATSTACK_SUPERVISOR_PORT") ?? 8099;
  const bindHost = args.bindHost ?? process.env["NATSTACK_SUPERVISOR_BIND_HOST"] ?? "127.0.0.1";
  const protocol = args.protocol ?? envProtocol() ?? (args.tlsCert ? "https" : "http");
  const host = args.host ?? process.env["NATSTACK_SUPERVISOR_HOST"] ?? "localhost";
  const publicParts = resolvePublicUrl({
    publicUrl: args.publicUrl ?? process.env["NATSTACK_SUPERVISOR_PUBLIC_URL"],
    protocol,
    host,
    port,
  });
  const auth = resolveOperatorAuth(args.operatorToken);
  const supervisor = new WorkspaceSupervisor({
    appRoot: args.appRoot ?? process.env["NATSTACK_APP_ROOT"] ?? process.cwd(),
    serverBundlePath: args.serverBundlePath ?? defaultServerBundlePath(),
    publicBaseUrl: publicParts.publicBaseUrl,
    publicBasePath: publicParts.publicBasePath,
    maxWorkspaces: args.maxWorkspaces,
    idleTimeoutMs: args.idleTimeoutMs,
    exposedWorkspaces: args.exposeWorkspace ? new Set(args.exposeWorkspace) : undefined,
    requireAuthToColdStart: args.requireAuthToColdStart,
    wsAllowedOrigins: publicParts.origin,
  });
  const gateway = new SupervisorGateway({
    supervisor,
    bindHost,
    port,
    publicBasePath: publicParts.publicBasePath,
    operatorToken: auth.token,
    allowCreate: args.allowCreate,
    tlsCert: args.tlsCert,
    tlsKey: args.tlsKey,
  });

  const shutdown = async () => {
    await gateway.stop().catch(() => undefined);
    await supervisor.shutdownAll().catch(() => undefined);
    process.exit(0);
  };
  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());

  const actualPort = await gateway.start();
  console.log(`natstack supervisor listening on ${bindHost}:${actualPort}`);
  console.log(`public URL: ${publicParts.publicBaseUrl || `${protocol}://${host}:${actualPort}`}`);
  if (auth.generated) {
    console.log(`operator token: ${auth.token}`);
  }
}

function resolvePublicUrl(opts: {
  publicUrl?: string;
  protocol: "http" | "https";
  host: string;
  port: number;
}): { publicBaseUrl: string; publicBasePath: string; origin: string } {
  const url = opts.publicUrl
    ? new URL(opts.publicUrl)
    : new URL(`${opts.protocol}://${opts.host}:${opts.port}`);
  const publicBasePath = url.pathname === "/" ? "" : url.pathname.replace(/\/+$/, "");
  url.pathname = publicBasePath || "/";
  url.search = "";
  url.hash = "";
  const publicBaseUrl = url.toString().replace(/\/$/, "");
  return { publicBaseUrl, publicBasePath, origin: url.origin };
}

function parsePort(value: string | undefined, label: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`);
  }
  return port;
}

function parsePositiveInt(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseNonNegativeInt(value: string | undefined, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0)
    throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function parseNameList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberEnv(name: string): number | undefined {
  const value = process.env[name];
  return value ? parsePort(value, name) : undefined;
}

function envProtocol(): "http" | "https" | undefined {
  const value = process.env["NATSTACK_SUPERVISOR_PROTOCOL"];
  if (value === "http" || value === "https") return value;
  return undefined;
}

function defaultServerBundlePath(): string {
  return path.resolve(process.cwd(), "dist/server.mjs");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
