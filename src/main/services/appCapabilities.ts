import type { AppCapability } from "@natstack/shared/unitManifest";
import type { ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { ViewManager } from "../viewManager.js";

export function requireAppCapability(
  ctx: ServiceContext,
  viewManager: ViewManager,
  capability: AppCapability,
  surface: string
): void {
  if (ctx.caller.runtime.kind !== "app") {
    throw new Error(`${surface} is restricted to app callers`);
  }
  const viewInfo = viewManager.getViewInfo(ctx.caller.runtime.id);
  if (viewInfo?.type === "app" && viewInfo.capabilities.includes(capability)) return;
  throw new Error(
    `${surface} requires app capability '${capability}' for ${ctx.caller.runtime.id}`
  );
}
