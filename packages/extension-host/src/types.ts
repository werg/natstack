import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type {
  ExtensionInvocation,
  ExtensionSource,
  InstallSpec,
  RegistryEntry,
} from "@natstack/extension";

export type {
  ExtensionInvocation,
  ExtensionSource,
  InstallSpec,
  RegistryEntry,
};

export interface ExtensionHealth {
  state: "healthy" | "degraded" | "unhealthy";
  summary: string;
  reasons?: string[];
  reportedAt: number;
  retryAt?: number;
}

export interface ExtensionProcessState {
  name: string;
  version: string;
  bundlePath: string;
  storageDir: string;
  gatewayUrl: string;
  rpcToken: string;
}

export interface ExtensionUserlandCaller {
  callerId: string;
  callerKind: "panel" | "worker" | "do";
  repoPath: string;
  effectiveVersion: string;
}

export function invocationFromServiceContext(
  ctx: ServiceContext,
  extensionName: string,
  method: string,
  requestId: string,
): ExtensionInvocation {
  const callerKind = ctx.caller.runtime.kind === "server" || ctx.caller.runtime.kind === "harness"
    ? "shell"
    : ctx.caller.runtime.kind;
  const invocation: ExtensionInvocation = {
    requestId,
    extensionName,
    method,
    caller: {
      callerId: ctx.caller.runtime.id,
      callerKind,
      ...(ctx.connectionId ? { connectionId: ctx.connectionId } : {}),
    },
  };
  if (
    ctx.caller.runtime.kind === "panel" ||
    ctx.caller.runtime.kind === "worker" ||
    ctx.caller.runtime.kind === "do"
  ) {
    const identity = ctx.caller.code;
    if (identity && identity.callerKind === ctx.caller.runtime.kind) {
      (invocation as ExtensionInvocation & { chainCaller?: ExtensionUserlandCaller }).chainCaller = {
        callerId: identity.callerId,
        callerKind: identity.callerKind,
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
      };
    }
  }
  return invocation;
}
