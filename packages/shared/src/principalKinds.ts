export const PRINCIPAL_KIND_REGISTRY = {
  panel: {
    callerKind: "panel",
    remoteCallerKind: null,
    codeIdentity: true,
  },
  app: {
    callerKind: "app",
    remoteCallerKind: null,
    codeIdentity: true,
  },
  worker: {
    callerKind: "worker",
    remoteCallerKind: null,
    codeIdentity: true,
  },
  do: {
    callerKind: "do",
    remoteCallerKind: null,
    codeIdentity: true,
  },
  extension: {
    callerKind: "extension",
    remoteCallerKind: null,
    codeIdentity: false,
  },
  shell: {
    callerKind: "shell",
    remoteCallerKind: "shell-remote",
    codeIdentity: false,
  },
  server: {
    callerKind: "server",
    remoteCallerKind: null,
    codeIdentity: false,
  },
  harness: {
    callerKind: "harness",
    remoteCallerKind: null,
    codeIdentity: false,
  },
} as const;

export type PrincipalKind = keyof typeof PRINCIPAL_KIND_REGISTRY;

export type CallerKind =
  | (typeof PRINCIPAL_KIND_REGISTRY)[PrincipalKind]["callerKind"]
  | NonNullable<(typeof PRINCIPAL_KIND_REGISTRY)[PrincipalKind]["remoteCallerKind"]>;

export type CodeIdentityCallerKind = {
  [Kind in PrincipalKind]: (typeof PRINCIPAL_KIND_REGISTRY)[Kind]["codeIdentity"] extends true
    ? (typeof PRINCIPAL_KIND_REGISTRY)[Kind]["callerKind"]
    : never;
}[PrincipalKind];

export function isPrincipalKind(value: string | null | undefined): value is PrincipalKind {
  return Boolean(value && value in PRINCIPAL_KIND_REGISTRY);
}

export function isCallerKind(value: string | null | undefined): value is CallerKind {
  if (!value) return false;
  return Object.values(PRINCIPAL_KIND_REGISTRY).some((entry) =>
    entry.callerKind === value || entry.remoteCallerKind === value
  );
}

export function isCodeIdentityCallerKind(value: string | null | undefined): value is CodeIdentityCallerKind {
  if (!value || !isPrincipalKind(value)) return false;
  return PRINCIPAL_KIND_REGISTRY[value].codeIdentity;
}

export function callerKindForPrincipalKind(
  kind: string | null | undefined,
  opts: { transport?: "local" | "ws" } = {},
): CallerKind {
  if (!isPrincipalKind(kind)) {
    throw new Error(`Unknown principal kind: ${String(kind)}`);
  }
  const entry = PRINCIPAL_KIND_REGISTRY[kind];
  if (opts.transport === "ws" && entry.remoteCallerKind) return entry.remoteCallerKind;
  return entry.callerKind;
}
