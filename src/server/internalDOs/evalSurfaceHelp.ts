/**
 * Eval `help('<name>')` surface description — the pure core, so it can be unit-tested under Node
 * (evalDO.ts pulls worker-only imports). `EvalDO.describeInjectedSurface` gathers the live binding's
 * method names + the RPC-service schema and hands them here.
 */

/**
 * Help notes for injected runtime methods whose ergonomic shape isn't captured by the raw RPC-service
 * schema (the wrappers that deliberately diverge from the wire methods). Keyed `binding.method`.
 */
export const EVAL_RUNTIME_METHOD_NOTES: Record<string, { description: string }> = {
  "fs.open": {
    description:
      "open(path, flags?, mode?) → FileHandle { fd, read(buf, off, len, pos), " +
      "write(data, off?, len?, pos?) where data is Uint8Array | string, close(), stat() }. " +
      "The low-level fs.handle* RPC methods are internal — use this FileHandle, not handle*.",
  },
  "fs.mktemp": {
    description:
      "mktemp(prefix?) → a unique temp FILE path under .tmp/ (the file is NOT created — write to it, " +
      "or use it as a name and rename into place). For a temp DIRECTORY, mkdir it yourself. This is " +
      "NOT Node's mkdtemp (which creates the directory), and .tmp paths are scratch space, not " +
      "tracked edit/VCS destinations.",
  },
  "workers.create": {
    description:
      "create({ source, contextId, name?, ref?, env?, bindings? }) → WorkerInstanceInfo. " +
      "Pass ref: `ctx:${ctx.contextId}` for worker code created or edited on the current context head; " +
      "omit ref only when intentionally launching the main build.",
  },
  "workers.destroy": {
    description:
      "destroy(name: string) → void. Pass the worker instance name, not the full object returned by " +
      "create() or list().",
  },
  "workers.listInstanceSources": {
    description:
      "listInstanceSources() → available worker-instance source packages. This is the ergonomic " +
      "runtime call for listing launchable worker sources; the raw catalog method " +
      '`workers.listSources` is reached with `rpc.call("main", "workers.listSources", [])`.',
  },
};

export interface InjectedSurfaceDescription {
  name: string;
  surface: "injected-runtime";
  note: string;
  methods: Record<string, unknown>;
}

export function invalidHelpArgumentResponse(value: unknown): Record<string, unknown> {
  const received =
    value && typeof value === "object"
      ? Object.keys(value as Record<string, unknown>).length > 0
        ? Object.keys(value as Record<string, unknown>)
            .slice(0, 8)
            .join(", ")
        : "object"
      : typeof value;
  return {
    error: "help() expects a string service or runtime binding name.",
    received,
    example: 'await help("workers")',
    note:
      "Pass the binding name as a string. For a live object's enumerable methods, " +
      "Object.keys(workers) also works.",
  };
}

/**
 * Describe an injected runtime binding as eval ACTUALLY sees it: its live method names, each enriched
 * from the RPC-service schema where names match — but a known ergonomic note wins (e.g. fs.open
 * returns a FileHandle, NOT the service's `{handleId}`), and methods absent from `liveMethodNames`
 * (the hidden wire methods like fs.handleClose) are dropped. Returns null when there are no live
 * methods, so the caller can fall back to the raw service schema.
 */
export function describeEvalBindingSurface(
  name: string,
  liveMethodNames: string[],
  serviceMethods: Record<string, unknown>,
  notes: Record<string, { description: string }> = EVAL_RUNTIME_METHOD_NOTES
): InjectedSurfaceDescription | null {
  if (liveMethodNames.length === 0) return null;
  const methods: Record<string, unknown> = {};
  for (const m of [...liveMethodNames].sort()) {
    methods[m] = notes[`${name}.${m}`] ??
      serviceMethods[m] ?? {
        description:
          "Runtime method — no RPC-service schema; introspect the return value or see skills/sandbox/EVAL.md.",
      };
  }
  return {
    name,
    surface: "injected-runtime",
    note:
      `Methods on the injected \`${name}\` binding — what eval code calls directly. The raw ` +
      `\`${name}\` RPC service (via \`rpc.call("main", "${name}.…", [...])\`) may differ. ` +
      `When a service name also exists as a runtime binding, \`services.${name}\` is this ` +
      `ergonomic client; use \`rpc.call\` for raw service-only methods. Low-level wire methods ` +
      `are intentionally hidden behind these wrappers.`,
    methods,
  };
}
