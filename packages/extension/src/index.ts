export interface Disposable {
  dispose(): void;
}

export interface ExtensionInvocation {
  requestId: string;
  /** Opaque host-issued token echoed by the runtime for attribution. */
  invocationToken?: string;
  extensionName: string;
  method: string;
  caller: {
    callerId: string;
    callerKind:
      | "panel"
      | "worker"
      | "do"
      | "shell"
      | "shell-remote"
      | "extension"
      | "http";
    connectionId?: string;
    contextId?: string;
  };
  chainCaller?: {
    callerId: string;
    callerKind: "panel" | "worker" | "do";
    repoPath: string;
    effectiveVersion: string;
    contextId?: string;
  };
}

export interface UserlandApprovalRequest {
  subject: { id: string; label?: string };
  title: string;
  summary?: string;
  warning?: string;
  details?: Array<{ label: string; value: string }>;
  promptOptions?: "scoped" | "choices";
  options?: Array<{ value: string; label: string; description?: string; tone?: "primary" | "danger" | "neutral" }>;
}

export type UserlandApprovalChoice =
  | { kind: "choice"; choice: string }
  | { kind: "dismissed" }
  | { kind: "uncallable"; reason: "no-user-context" };

export interface ExtensionSource {
  kind: "internal-git";
  repo: string;
  ref: string;
}

export interface RegistryEntry {
  name: string;
  version: string;
  source: ExtensionSource;
  installedAt: number;
  activeEv: string | null;
  activeSha: string | null;
  activeBundleKey: string | null;
  activeDependencyEvs: Record<string, string>;
  activeExternalDeps: Record<string, string>;
  activeRuntimeDepsKey: string | null;
  enabled: boolean;
  status: "running" | "stopped" | "error" | "pending-approval" | "building";
  lastError: string | null;
}

/**
 * Open registry of the workspace's installed extensions, mapping each
 * extension's package name to its public API type. Each extension augments
 * this interface from its own module:
 *
 * ```ts
 * export type Api = Awaited<ReturnType<typeof activate>>;
 * declare module "@natstack/extension" {
 *   interface WorkspaceExtensions { "@workspace-extensions/foo": Api; }
 * }
 * ```
 *
 * `ExtensionsClient.use` is keyed on `keyof WorkspaceExtensions`, so a
 * registered name infers its API type and an unregistered name is a compile
 * error. There is deliberately no `string` fallback.
 */
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface WorkspaceExtensions {}

/** Name of any extension registered in {@link WorkspaceExtensions}. */
export type ExtensionName = keyof WorkspaceExtensions & string;

export interface ExtensionsClient {
  /**
   * Create a typed client for a registered extension. The returned object's
   * methods are the extension's `activate` return type. Streaming methods
   * (those returning `Response`) are declared by the extension's manifest and
   * routed through `extensions.invokeStream` automatically; pass
   * `options.streamingMethods` only to override that resolution.
   */
  use<K extends ExtensionName>(
    name: K,
    options?: { streamingMethods?: Iterable<string> },
  ): WorkspaceExtensions[K];
  on(name: ExtensionName, event: string, cb: (payload: unknown) => void): Disposable;
  list(): Promise<RegistryEntry[]>;
  /** Restart the active approved build (dev/diagnostics). Approval-gated. */
  reload(name: ExtensionName): Promise<void>;
}

/**
 * Minimal RPC surface the extensions client needs. Both the workspace runtime
 * (`RpcCaller`) and host-side callers (harness, etc.) satisfy this shape.
 */
export interface ExtensionsClientRpc {
  call(target: string, method: string, args: unknown[]): Promise<unknown>;
  streamCall(target: string, method: string, args: unknown[]): Promise<Response>;
  onEvent?: (event: string, listener: (fromId: string, payload: unknown) => void) => () => void;
}

const IGNORED_PROXY_PROPS = new Set<PropertyKey>([
  "then",
  "catch",
  "finally",
  "constructor",
  Symbol.toPrimitive,
  Symbol.toStringTag,
  "inspect",
  "toJSON",
]);

/**
 * Build the invocation proxy for a single extension. Method access becomes a
 * unary `extensions.invoke` call, or `extensions.invokeStream` when the method
 * is in `resolveStreaming(...)`. The proxy methods are async so streaming
 * resolution (which may await the registry) never races the first call.
 */
export function createExtensionProxy<T extends object>(
  rpc: Pick<ExtensionsClientRpc, "call" | "streamCall">,
  name: string,
  resolveStreaming: (method: string) => boolean | Promise<boolean>,
): T {
  return new Proxy(Object.create(null), {
    get(_target, prop) {
      if (IGNORED_PROXY_PROPS.has(prop) || typeof prop !== "string") return undefined;
      return async (...args: unknown[]) => {
        const streaming = await resolveStreaming(prop);
        return streaming
          ? rpc.streamCall("main", "extensions.invokeStream", [name, prop, args])
          : rpc.call("main", "extensions.invoke", [name, prop, args]);
      };
    },
  }) as T;
}

/**
 * Construct the canonical typed extensions client over any
 * {@link ExtensionsClientRpc}. Streaming-method routing is resolved from the
 * extension manifest via `extensions.streamingMethods`, cached per client, and
 * overridable through `use(name, { streamingMethods })`.
 */
export function createExtensionsClient(rpc: ExtensionsClientRpc): ExtensionsClient {
  const streamingCache = new Map<string, Promise<Set<string>>>();
  const declaredStreaming = (name: string): Promise<Set<string>> => {
    let cached = streamingCache.get(name);
    if (!cached) {
      cached = rpc
        .call("main", "extensions.streamingMethods", [name])
        .then((methods) => new Set((methods as string[] | null) ?? []))
        .catch(() => new Set<string>());
      streamingCache.set(name, cached);
    }
    return cached;
  };
  const client: ExtensionsClient = {
    use(name, options) {
      const override = options?.streamingMethods ? new Set(options.streamingMethods) : null;
      return createExtensionProxy(
        rpc,
        name,
        override ? (method) => override.has(method) : (method) => declaredStreaming(name).then((s) => s.has(method)),
      ) as WorkspaceExtensions[typeof name];
    },
    on(name, event, cb) {
      const eventName = `extensions:${name}::${event}`;
      const unsubscribe = rpc.onEvent
        ? rpc.onEvent(`event:${eventName}`, (_fromId, payload) => cb(payload))
        : () => {};
      void rpc.call("main", "extensions.on", [name, event]);
      return { dispose: unsubscribe };
    },
    list: () => rpc.call("main", "extensions.list", []) as Promise<RegistryEntry[]>,
    reload: (name) => rpc.call("main", "extensions.reload", [name]) as Promise<void>,
  };
  return client;
}

export interface ExtensionFileStats {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
  mtime: Date;
  ctime: Date;
  mode: number;
}

export interface ExtensionFileHandle {
  fd: number;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ bytesRead: number; buffer: Uint8Array }>;
  write(
    buffer: Uint8Array,
    offset?: number,
    length?: number,
    position?: number | null,
  ): Promise<{ bytesWritten: number; buffer: Uint8Array }>;
  close(): Promise<void>;
  stat(): Promise<ExtensionFileStats>;
}

export interface ExtensionFsClient {
  constants: { F_OK: 0; R_OK: 4; W_OK: 2; X_OK: 1 };
  readFile(path: string, encoding?: BufferEncoding): Promise<string | Buffer>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  appendFile(path: string, data: string | Uint8Array): Promise<void>;
  readdir(path: string, options?: { withFileTypes?: boolean }): Promise<unknown[]>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  rmdir(path: string): Promise<void>;
  rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  stat(path: string): Promise<ExtensionFileStats>;
  lstat(path: string): Promise<ExtensionFileStats>;
  access(path: string, mode?: number): Promise<void>;
  exists(path: string): Promise<boolean>;
  unlink(path: string): Promise<void>;
  copyFile(src: string, dest: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  realpath(path: string): Promise<string>;
  open(path: string, flags?: string, mode?: number): Promise<ExtensionFileHandle>;
  truncate(path: string, len?: number): Promise<void>;
  readlink(path: string): Promise<string>;
  symlink(target: string, path: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  chown(path: string, uid: number, gid: number): Promise<void>;
  utimes(path: string, atime: Date | number, mtime: Date | number): Promise<void>;
}

export interface HealthDetail {
  summary: string;
  reasons?: string[];
  retryAt?: number;
}

/**
 * Catch-all RPC client shape for host services not yet typed in this package.
 * Authors who want richer types can cast to the matching client interface
 * from `@workspace/runtime` (e.g. `WorkspaceClient`, `CredentialClient`,
 * `WebhookIngressClient`, `NotificationClient`).
 */
export type ExtensionRpcSurface = Record<string, (...args: unknown[]) => Promise<unknown>>;

export interface ExtensionWorkspaceLike {
  /** Information about the active workspace. */
  getInfo(): Promise<{ id: string; name: string; path: string; contextsPath: string }>;
}

export interface ExtensionNotificationsLike {
  show(notification: { id?: string; type?: string; title?: string; message?: string }): Promise<string>;
  dismiss(id: string): Promise<void>;
}

export interface ExtensionWorkersLike {
  /** Resolve a manifest-declared userland service by name or protocol. */
  resolveService(query: string, objectKey?: string | null): Promise<unknown>;
  /** Resolve a concrete Durable Object target and grant this extension relay access. */
  resolveDurableObject(source: string, className: string, objectKey: string): Promise<unknown>;
  /** List manifest-declared userland services. */
  listServices(): Promise<unknown[]>;
}

export interface ExtensionRpcLike {
  /** Call any unified RPC target, including `main`, `worker:*`, and `do:*`. */
  call<T = unknown>(targetId: string, method: string, ...args: unknown[]): Promise<T>;
  /** Open a streaming RPC call to any unified RPC target. */
  streamCall(targetId: string, method: string, args: unknown[], options?: { signal?: AbortSignal }): Promise<Response>;
  /** Subscribe to host-delivered events where supported by the runtime. */
  onEvent(eventName: string, cb: (fromId: string, payload: unknown) => void): () => void;
}

export interface ExtensionContext {
  readonly name: string;
  readonly version: string;
  readonly storage: {
    mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
    readFile(path: string, encoding?: BufferEncoding): Promise<string | Buffer>;
    writeFile(path: string, data: string | Uint8Array): Promise<void>;
    rm(path: string, opts?: { recursive?: boolean; force?: boolean }): Promise<void>;
    readdir(path?: string): Promise<string[]>;
  };
  readonly fs: ExtensionFsClient;
  readonly git: ExtensionRpcSurface;
  readonly workspace: ExtensionWorkspaceLike;
  readonly rpc: ExtensionRpcLike;
  readonly workers: ExtensionWorkersLike;
  readonly credentials: ExtensionRpcSurface;
  readonly webhooks: ExtensionRpcSurface;
  readonly approvals: {
    request(req: UserlandApprovalRequest): Promise<UserlandApprovalChoice>;
    revoke(subjectId: string): Promise<boolean>;
    list(): Promise<unknown[]>;
  };
  readonly notifications: ExtensionNotificationsLike;
  readonly extensions: ExtensionsClient;
  readonly invocation: {
    current(): ExtensionInvocation | null;
  };
  readonly subscriptions: Disposable[];
  readonly log: {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
  };
  readonly health: {
    report(state: "healthy" | "degraded" | "unhealthy", detail?: HealthDetail): void;
    healthy(detail?: HealthDetail): void;
    degraded(detail: HealthDetail): void;
    unhealthy(detail: HealthDetail): void;
  };
  emit(event: string, payload: unknown): void;
}

export interface ExtensionFetchContext extends ExtensionContext {
  waitUntil(promise: Promise<unknown>): void;
}
