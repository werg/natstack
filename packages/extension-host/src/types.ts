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

export interface ExtensionHostCodeIdentityResolver {
  resolveByCallerId(callerId: string): {
    callerId: string;
    callerKind: "panel" | "worker";
    repoPath: string;
    effectiveVersion: string;
  } | null;
}

export function invocationFromServiceContext(
  ctx: ServiceContext,
  extensionName: string,
  method: string,
  requestId: string,
  identityResolver: ExtensionHostCodeIdentityResolver,
): ExtensionInvocation {
  const callerKind = ctx.callerKind === "server" || ctx.callerKind === "harness"
    ? "shell"
    : ctx.callerKind;
  const invocation: ExtensionInvocation = {
    requestId,
    extensionName,
    method,
    caller: {
      callerId: ctx.callerId,
      callerKind,
      ...(ctx.connectionId ? { connectionId: ctx.connectionId } : {}),
    },
  };
  if (ctx.callerKind === "panel" || ctx.callerKind === "worker") {
    const identity = identityResolver.resolveByCallerId(ctx.callerId);
    if (identity && identity.callerKind === ctx.callerKind) {
      invocation.userlandCaller = {
        callerId: identity.callerId,
        callerKind: identity.callerKind,
        repoPath: identity.repoPath,
        effectiveVersion: identity.effectiveVersion,
      };
    }
  }
  return invocation;
}
