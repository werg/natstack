export interface Disposable {
  dispose(): void;
}

export interface ExtensionInvocation {
  requestId: string;
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
  };
  userlandCaller?: {
    callerId: string;
    callerKind: "panel" | "worker" | "do";
    repoPath: string;
    effectiveVersion: string;
  };
}

export interface UserlandApprovalRequest {
  subject: { id: string; label?: string };
  title: string;
  summary?: string;
  warning?: string;
  details?: Array<{ label: string; value: string }>;
  options: Array<{ value: string; label: string; description?: string; tone?: "primary" | "danger" | "neutral" }>;
}

export type UserlandApprovalChoice =
  | { kind: "choice"; choice: string }
  | { kind: "dismissed" };

export interface ExtensionSource {
  kind: "internal-git";
  repo: string;
  ref: string;
}

export interface InstallSpec {
  source: ExtensionSource;
}

export interface RegistryEntry {
  name: string;
  version: string;
  source: InstallSpec["source"];
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

export interface ExtensionsClient {
  use<T extends object>(name: string): T;
  on(name: string, event: string, cb: (payload: unknown) => void): Disposable;
  list(): Promise<RegistryEntry[]>;
  install(spec: InstallSpec): Promise<void>;
  uninstall(name: string, opts?: { purge?: boolean }): Promise<void>;
  setEnabled(name: string, enabled: boolean): Promise<void>;
  update(name: string): Promise<void>;
  reload(name: string): Promise<void>;
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
    requestForCaller(req: UserlandApprovalRequest): Promise<UserlandApprovalChoice>;
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
