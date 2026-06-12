/**
 * Eval runner — the child process behind `natstack eval run`.
 *
 * Bundled standalone (dist/cli/eval-runner.mjs, see build.mjs) so the parent
 * CLI can spawn it with plain `node`. Protocol:
 *
 *   stdin:  one JSON handshake document (read to EOF)
 *   stdout: NDJSON events — {type:"console",...} while running, then exactly
 *           one {type:"result",...} before exit
 *
 * The sandbox itself is @workspace/eval's executeSandbox with the same
 * binding surface as the in-app eval tool: rpc, services, fs (context-bound),
 * ctx, scope (REPL persistence), help().
 */
import { pathToFileURL } from "node:url";
import {
  executeSandbox,
  serializeScope,
  deserializeScope,
  type SerializedScope,
} from "@workspace/eval";

export interface EvalHandshake {
  code: string;
  syntax?: "typescript" | "jsx" | "tsx";
  imports?: Record<string, string>;
  serverUrl: string;
  shellToken: string;
  contextId: string;
  sessionId: string;
  workspaceId?: string;
  /** Serialized scope JSON (ScopeEntry.data) to restore, if any. */
  scopeSnapshot?: string;
}

export type ConsoleEvent = {
  type: "console";
  level: "log" | "warn" | "error" | "info" | "debug";
  text: string;
  ts: number;
};

export interface ResultEvent {
  type: "result";
  success: boolean;
  returnValue?: unknown;
  returnTruncated?: boolean;
  error?: string;
  /**
   * Serialized final scope, for the parent to persist. Omitted on
   * infrastructure failures (invalid handshake, runner crash) where the
   * sandbox never produced a scope — the parent must keep the stored one.
   */
  scope?: SerializedScope;
}

export type RunnerEvent = ConsoleEvent | ResultEvent;

const MAX_RETURN_VALUE_JSON_CHARS = 256 * 1024;

// ---------------------------------------------------------------------------
// HTTP RPC bridge
// ---------------------------------------------------------------------------

export interface RunnerRpc {
  /** Direct service dispatch on the server ("service.method"). */
  call(method: string, args: unknown[]): Promise<unknown>;
  /** Relay call to a runtime target by entity/target id. */
  callTarget(targetId: string, method: string, args: unknown[]): Promise<unknown>;
}

/** Minimal Bearer-token POST /rpc bridge (token refresh is the parent's job). */
export function createRunnerRpc(serverUrl: string, shellToken: string): RunnerRpc {
  async function post(body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(new URL("/rpc", serverUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${shellToken}`,
      },
      body: JSON.stringify(body),
    });
    const parsed = (await response.json().catch(() => ({}))) as {
      result?: unknown;
      error?: unknown;
      errorCode?: unknown;
    };
    if (response.status === 401) {
      // The runner holds a single token issued at startup; a 401 mid-run
      // means the server restarted or revoked it (tokens have no TTL).
      throw new Error("shell token rejected (server restarted?) — rerun the eval");
    }
    if (typeof parsed.error === "string") {
      const error = new Error(parsed.error);
      if (typeof parsed.errorCode === "string") {
        (error as Error & { code?: string }).code = parsed.errorCode;
      }
      throw error;
    }
    if (!response.ok) {
      throw new Error(`rpc failed (${response.status} ${response.statusText})`);
    }
    return parsed.result;
  }

  return {
    call: (method, args) => post({ method, args }),
    callTarget: (targetId, method, args) => post({ type: "call", targetId, method, args }),
  };
}

// ---------------------------------------------------------------------------
// Sandbox bindings
// ---------------------------------------------------------------------------

/** `services.git.status(...)` → rpc call "git.status". */
function createServicesProxy(rpc: RunnerRpc): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, service) {
        if (typeof service !== "string" || service === "then") return undefined;
        return new Proxy(
          {},
          {
            get(_inner, method) {
              if (typeof method !== "string" || method === "then") return undefined;
              return (...args: unknown[]) => rpc.call(`${service}.${method}`, args);
            },
          }
        );
      },
    }
  );
}

/** Context-bound fs: `fs.readFile("/a.txt")` → fs.readFile(contextId, "/a.txt"). */
function createFsBinding(rpc: RunnerRpc, contextId: string): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_target, method) {
        if (typeof method !== "string" || method === "then") return undefined;
        return (...args: unknown[]) => rpc.call(`fs.${method}`, [contextId, ...args]);
      },
    }
  );
}

/** Scope proxy over a backing map — same access semantics as ScopeManager. */
function createScopeProxy(backing: Map<string, unknown>): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    get: (_target, prop: string) => backing.get(prop),
    set: (_target, prop: string, value) => {
      backing.set(prop, value);
      return true;
    },
    deleteProperty: (_target, prop: string) => {
      backing.delete(prop);
      return true;
    },
    has: (_target, prop: string) => backing.has(prop),
    ownKeys: () => Array.from(backing.keys()),
    getOwnPropertyDescriptor: (_target, prop: string) => {
      if (!backing.has(prop)) return undefined;
      return { configurable: true, enumerable: true, writable: true, value: backing.get(prop) };
    },
  });
}

/** Same import loader as the in-app sandbox: server-side build over RPC. */
function createLoadImport(rpc: RunnerRpc) {
  return async (
    specifier: string,
    ref: string | undefined,
    externals: string[]
  ): Promise<string> => {
    if (ref?.startsWith("npm:")) {
      const version = ref.slice(4) || "latest";
      const result = (await rpc.call("build.getBuildNpm", [specifier, version, externals])) as {
        bundle: string;
      };
      return result.bundle;
    }
    const result = (await rpc.call("build.getBuild", [
      specifier,
      ref,
      { library: true, externals },
    ])) as {
      bundle: string;
    };
    return result.bundle;
  };
}

/**
 * Install the module-map globals executeSandbox expects (mirrors the
 * generateModuleMapBootstrap emitted into built panel/worker bundles).
 */
function installModuleBootstrap(): void {
  const globals = globalThis as Record<string, unknown>;
  const moduleMap = (globals["__natstackModuleMap__"] ??= {}) as Record<string, unknown>;
  globals["__natstackRequire__"] = (id: string): unknown => {
    const mod = moduleMap[id];
    if (mod) return mod;
    throw new Error(
      `Module "${id}" not available. Workspace packages (@workspace/*, @natstack/*) are auto-resolved. ` +
        `For npm packages, use imports: { "${id}": "npm:latest" }`
    );
  };
}

// ---------------------------------------------------------------------------
// Result shaping
// ---------------------------------------------------------------------------

export function boundReturnValue(value: unknown): {
  returnValue?: unknown;
  returnTruncated?: boolean;
} {
  if (value === undefined || value === null) return {};
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    json = undefined;
  }
  if (json === undefined) return { returnValue: { __unserializable: typeof value } };
  if (json.length > MAX_RETURN_VALUE_JSON_CHARS) {
    return { returnValue: json.slice(0, MAX_RETURN_VALUE_JSON_CHARS), returnTruncated: true };
  }
  return { returnValue: value };
}

function parseConsoleLevel(formatted: string): {
  level: ConsoleEvent["level"];
  text: string;
} {
  const match = formatted.match(/^\[(WARN|ERROR|INFO|DEBUG)\] /);
  const tag = match?.[1];
  if (!match || tag === undefined) return { level: "log", text: formatted };
  return {
    level: tag.toLowerCase() as ConsoleEvent["level"],
    text: formatted.slice(match[0].length),
  };
}

// ---------------------------------------------------------------------------
// Eval execution
// ---------------------------------------------------------------------------

export async function runEval(
  handshake: EvalHandshake,
  emit: (event: RunnerEvent) => void
): Promise<ResultEvent> {
  installModuleBootstrap();
  const rpc = createRunnerRpc(handshake.serverUrl, handshake.shellToken);

  const scopeBacking = handshake.scopeSnapshot
    ? deserializeScope(handshake.scopeSnapshot)
    : new Map<string, unknown>();
  const scope = createScopeProxy(scopeBacking);

  const ctx = {
    contextId: handshake.contextId,
    sessionId: handshake.sessionId,
    workspaceId: handshake.workspaceId,
    serverUrl: handshake.serverUrl,
  };

  const help = async (serviceName?: string): Promise<unknown> => {
    if (serviceName) return await rpc.call("meta.describeService", [serviceName]);
    const [services, skillPackages] = await Promise.all([
      rpc.call("meta.listServices", []),
      rpc.call("build.listSkills", []).catch((err: unknown) => ({
        error: err instanceof Error ? err.message : String(err),
      })),
    ]);
    return {
      preInjected: ["rpc", "services", "fs", "ctx", "scope", "help"],
      services,
      imports: {
        description: "Use the eval `imports` parameter to load additional packages on-demand.",
        usage:
          'Workspace packages (@workspace/*, @natstack/*) are auto-resolved. For npm: imports: { "lodash": "npm:4" }.',
        workspaceSkills: skillPackages,
      },
    };
  };

  const sandboxResult = await executeSandbox(handshake.code, {
    syntax: handshake.syntax ?? "tsx",
    imports: handshake.imports,
    loadImport: createLoadImport(rpc),
    bindings: {
      rpc: {
        call: (method: string, args: unknown[] = []) => rpc.call(method, args),
        callTarget: (targetId: string, method: string, args: unknown[] = []) =>
          rpc.callTarget(targetId, method, args),
      },
      services: createServicesProxy(rpc),
      fs: createFsBinding(rpc, handshake.contextId),
      ctx,
      scope,
      help,
    },
    onConsole: (formatted) => {
      const { level, text } = parseConsoleLevel(formatted);
      emit({ type: "console", level, text, ts: Date.now() });
    },
  });

  const result: ResultEvent = {
    type: "result",
    success: sandboxResult.success,
    ...(sandboxResult.success
      ? boundReturnValue(sandboxResult.returnValue)
      : { error: sandboxResult.error ?? "Eval failed" }),
    scope: serializeScope(scopeBacking),
  };
  emit(result);
  return result;
}

// ---------------------------------------------------------------------------
// Process entry point
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<number> {
  const emit = (event: RunnerEvent): void => {
    process.stdout.write(`${JSON.stringify(event)}\n`);
  };
  let handshake: EvalHandshake;
  try {
    handshake = JSON.parse(await readStdin()) as EvalHandshake;
    if (typeof handshake.code !== "string" || typeof handshake.serverUrl !== "string") {
      throw new Error("handshake must include code and serverUrl");
    }
  } catch (error) {
    // Infrastructure failure: omit `scope` so the parent keeps the stored one.
    emit({
      type: "result",
      success: false,
      error: `invalid eval handshake: ${error instanceof Error ? error.message : String(error)}`,
    });
    return 1;
  }
  try {
    await runEval(handshake, emit);
    return 0;
  } catch (error) {
    // Infrastructure failure: omit `scope` so the parent keeps the stored one.
    emit({
      type: "result",
      success: false,
      error: error instanceof Error ? error.message : String(error),
    });
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  );
}
