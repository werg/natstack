import type { RpcAccessPolicy, RpcCallerContext } from "./types.js";

export const allowAllCallers: RpcAccessPolicy = () => true;

export const denyAllCallers: RpcAccessPolicy = () => false;

export function allowCallerIds(...sourceIds: string[]): RpcAccessPolicy {
  const allowed = new Set(sourceIds);
  return (ctx: RpcCallerContext) => allowed.has(ctx.sourceId);
}

export function allowSourcePrefixes(...prefixes: string[]): RpcAccessPolicy {
  return (ctx: RpcCallerContext) => prefixes.some((prefix) => ctx.sourceId.startsWith(prefix));
}
