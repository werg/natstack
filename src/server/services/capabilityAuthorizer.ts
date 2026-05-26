import type { VerifiedCaller } from "@natstack/shared/serviceDispatcher";
import type { AppCapability } from "@natstack/shared/unitManifest";
import type { CallerKind } from "@natstack/shared/principalKinds";

export interface CapabilityDecision {
  allowed: boolean;
  reason?: string;
}

export interface CapabilityAuthorizer {
  check(
    caller: VerifiedCaller,
    capability: AppCapability,
    options?: CapabilityCheckOptions
  ): CapabilityDecision;
  require(
    caller: VerifiedCaller,
    capability: AppCapability,
    options?: CapabilityCheckOptions
  ): void;
}

export interface CapabilityCheckOptions {
  hostKinds?: readonly CallerKind[];
}

export class CapabilityAccessError extends Error {
  readonly code = "EACCES";

  constructor(message: string) {
    super(message);
    this.name = "CapabilityAccessError";
  }
}

export function createCapabilityAuthorizer(deps: {
  hasAppCapability?: (callerId: string, capability: AppCapability) => boolean;
}): CapabilityAuthorizer {
  return {
    check(caller, capability, options = {}) {
      const kind = caller.runtime.kind;
      if (options.hostKinds?.includes(kind)) {
        return { allowed: true };
      }
      if (kind === "app") {
        if (deps.hasAppCapability?.(caller.runtime.id, capability)) return { allowed: true };
        return {
          allowed: false,
          reason: `App ${caller.runtime.id} does not have capability '${capability}'`,
        };
      }
      return {
        allowed: false,
        reason: `Caller kind '${kind}' cannot use capability '${capability}'`,
      };
    },
    require(caller, capability, options) {
      const decision = this.check(caller, capability, options);
      if (decision.allowed) return;
      throw new CapabilityAccessError(decision.reason ?? `Capability '${capability}' is required`);
    },
  };
}
