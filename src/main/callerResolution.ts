import {
  callerKindForPrincipalKind,
  isPrincipalKind,
  type CallerKind,
  type PrincipalKind,
} from "@natstack/shared/principalKinds";

export type ElectronViewCallerKind = Extract<CallerKind, "shell" | "panel" | "app">;

export interface ElectronViewInfoForCallerResolution {
  type: string;
}

export function callerKindForElectronViewType(
  type: string | null | undefined
): ElectronViewCallerKind {
  if (type !== "shell" && type !== "panel" && type !== "app") {
    throw new Error(`Unknown Electron view principal kind: ${String(type)}`);
  }
  if (!isPrincipalKind(type)) {
    throw new Error(`Electron view type is not a registered principal kind: ${type}`);
  }
  return callerKindForPrincipalKind(type as PrincipalKind) as ElectronViewCallerKind;
}

export function resolveElectronViewCaller(
  callerId: string,
  viewInfo: ElectronViewInfoForCallerResolution | null | undefined
): { callerId: string; callerKind: ElectronViewCallerKind } {
  if (callerId === "shell") return { callerId, callerKind: callerKindForElectronViewType("shell") };
  if (!viewInfo) {
    throw new Error(`Unknown Electron view caller: ${callerId}`);
  }
  return {
    callerId,
    callerKind: callerKindForElectronViewType(viewInfo.type),
  };
}
