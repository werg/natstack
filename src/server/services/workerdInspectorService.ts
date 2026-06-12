/**
 * workerdInspector service — approval-gated userland access to the workerd
 * V8 inspector for profiling workers and Durable Objects.
 *
 * Not dev-gated: NatStack is a continuous-development system, so the
 * inspector stays available; the approvals flow (capability
 * "workerd.inspector", grantable per caller) is the access control, matching
 * the panelCdp model. The inspector socket itself binds loopback and is only
 * reachable through the WorkerdInspectorBridge with a single-use grant token.
 */
import { z } from "zod";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";
import type { WorkerdInspectorTarget } from "../workerdInspectorBridge.js";
import {
  requestCapabilityPermission,
  type CapabilityPermissionDeps,
} from "./capabilityPermission.js";

export const WORKERD_INSPECTOR_CAPABILITY = "workerd.inspector";

export interface WorkerdInspectorServiceDeps extends CapabilityPermissionDeps {
  listTargets(): Promise<WorkerdInspectorTarget[]>;
  getEndpoint(
    targetPath: string,
    principalId: string
  ): { wsEndpoint: string; token: string } | null;
}

export function createWorkerdInspectorService(
  deps: WorkerdInspectorServiceDeps
): ServiceDefinition {
  return {
    name: "workerdInspector",
    description: "Approval-gated workerd V8 inspector access for profiling workers and DOs",
    policy: { allowed: ["shell", "server", "panel", "worker", "do"] },
    methods: {
      listTargets: { args: z.tuple([]) },
      getEndpoint: { args: z.tuple([z.string()]) },
    },
    handler: async (ctx, method, args) => {
      switch (method) {
        case "listTargets":
          return deps.listTargets();

        case "getEndpoint": {
          const targetPath = args[0] as string;
          const caller = ctx.caller;
          if (caller.runtime.kind !== "shell" && caller.runtime.kind !== "server") {
            const permission = await requestCapabilityPermission(deps, {
              caller,
              capability: WORKERD_INSPECTOR_CAPABILITY,
              dedupKey: `workerd-inspector:${caller.runtime.id}`,
              resource: {
                type: "workerd-inspector",
                label: "Workerd inspector target",
                value: targetPath,
                // One grant covers all targets for the caller — targets are
                // ephemeral per-service paths, not meaningful trust boundaries.
                key: `caller:${caller.runtime.id}`,
              },
              title: "Profile workers via the workerd inspector",
              description:
                `Allow ${caller.runtime.kind} ${caller.runtime.id} to attach the V8 inspector ` +
                `to workerd (CPU profiles, heap inspection of workers and durable objects).`,
              details: [
                { label: "Caller", value: `${caller.runtime.kind} ${caller.runtime.id}` },
                { label: "Target", value: targetPath },
              ],
              deniedReason: "Workerd inspector access denied",
            });
            if (!permission.allowed) {
              throw new Error(permission.reason ?? "Workerd inspector access denied");
            }
          }
          const endpoint = deps.getEndpoint(targetPath, caller.runtime.id);
          if (!endpoint) {
            throw new Error(
              "Workerd inspector is unavailable (disabled via NATSTACK_DISABLE_WORKERD_INSPECTOR or workerd not running)"
            );
          }
          return endpoint;
        }

        default:
          throw new Error(`Unknown workerdInspector method: ${method}`);
      }
    },
  };
}
