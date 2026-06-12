import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import { scopeMethods } from "@natstack/shared/serviceSchemas/scope";
import { INTERNAL_DO_SOURCE } from "../internalDOs/internalDoLoader.js";
import type { DODispatch } from "../doDispatch.js";

export function createScopeService(deps: { doDispatch: DODispatch }): ServiceDefinition {
  const ref = {
    source: INTERNAL_DO_SOURCE,
    className: "ScopeStoreDO",
    objectKey: "global",
  };

  return {
    name: "scope",
    description: "REPL scope persistence backed by an internal Durable Object",
    policy: { allowed: ["panel", "app", "worker", "do", "extension", "shell", "server"] },
    methods: scopeMethods,
    handler: (_ctx, method, args) => deps.doDispatch.dispatch(ref, method, ...args),
  };
}
