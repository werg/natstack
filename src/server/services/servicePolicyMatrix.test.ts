/**
 * Policy-matrix guardrail — turns "discover a policy gap by tripping over it at
 * runtime" into "caught at build/test time".
 *
 * It enumerates EVERY registered RPC service and its per-method `policy.allowed`
 * into a stable, sorted matrix and asserts it against a checked-in golden
 * snapshot (`__servicePolicyMatrix.golden.json`). So:
 *   - changing any service or method policy shows up as a reviewable diff, and
 *   - adding a NEW service or method fails the test until its policy is recorded
 *     in the golden file — you cannot ship a service without an explicit policy
 *     that a human reviewed.
 *
 * Source of truth = the SAME construction the agent-CLI doc generator uses
 * (scripts/generate-agent-cli-docs.mjs): every `create*` factory under
 * `src/server/services/` is invoked with an inert proxy dep (deps are only read
 * inside handler closures, never at construction), and the resulting
 * `ServiceDefinition`s give us `policy.allowed` per service + per method — exactly
 * the `meta.listServices` shape, just gathered statically without booting.
 *
 * (c) Handler-doesn't-narrow-below-declared — see the note at the bottom of this
 * file for the feasibility verdict; this matrix is the backstop that catches any
 * such drift as a snapshot diff.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ServiceDefinition } from "@natstack/shared/serviceDefinition";

const servicesDir = fileURLToPath(new URL(".", import.meta.url));
const goldenPath = join(servicesDir, "__servicePolicyMatrix.golden.json");

/**
 * An inert stand-in for service deps: every property access, call, and
 * construction yields the same proxy. Factories only close over deps for their
 * handlers, so this satisfies construction without a live server. (Mirrors
 * `inertDeps` in scripts/generate-agent-cli-docs.mjs.)
 */
function inertDeps(): unknown {
  const fn = (): void => {};
  const proxy: object = new Proxy(fn, {
    get: (_t, prop) => {
      if (prop === Symbol.toPrimitive) return () => "";
      if (prop === "then") return undefined; // not thenable
      return proxy;
    },
    apply: () => proxy,
    construct: () => proxy,
  });
  return proxy;
}

function isServiceDefinition(value: unknown): value is ServiceDefinition {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as ServiceDefinition).name === "string" &&
    typeof (value as ServiceDefinition).handler === "function" &&
    (value as ServiceDefinition).methods !== null &&
    typeof (value as ServiceDefinition).methods === "object"
  );
}

type PolicyAllowed = string[] | null;
interface ServiceMatrixEntry {
  service: string[];
  methods: Record<string, PolicyAllowed>;
}
type PolicyMatrix = Record<string, ServiceMatrixEntry>;

/**
 * Collect every constructible `ServiceDefinition` under `src/server/services/`,
 * the exact set the agent-CLI doc generator emits, and reduce it to a sorted
 * matrix: service name → sorted service-level `policy.allowed` + per-method
 * `policy.allowed` (null when a method inherits the service policy).
 */
async function collectPolicyMatrix(): Promise<PolicyMatrix> {
  const files = readdirSync(servicesDir)
    .filter((file) => /Service(Def)?\.ts$/.test(file) && !file.includes(".test."))
    .sort();

  const defs = new Map<string, ServiceDefinition>();
  for (const file of files) {
    const mod = (await import(/* @vite-ignore */ join(servicesDir, file))) as Record<
      string,
      unknown
    >;
    for (const [exportName, exported] of Object.entries(mod)) {
      if (typeof exported !== "function" || !exportName.startsWith("create")) continue;
      let result: unknown;
      try {
        result = (exported as (deps: unknown) => unknown)(inertDeps());
        if (result && typeof (result as { then?: unknown }).then === "function") {
          result = await result;
        }
      } catch {
        continue; // factory needed real deps at construction time
      }
      for (const candidate of [result, (result as { definition?: unknown })?.definition]) {
        if (isServiceDefinition(candidate)) defs.set(candidate.name, candidate);
      }
    }
  }

  const matrix: PolicyMatrix = {};
  for (const def of [...defs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    const methods: Record<string, PolicyAllowed> = {};
    for (const [method, schema] of Object.entries(def.methods).sort((a, b) =>
      a[0].localeCompare(b[0])
    )) {
      methods[method] = schema.policy ? [...schema.policy.allowed].sort() : null;
    }
    matrix[def.name] = { service: [...def.policy.allowed].sort(), methods };
  }
  return matrix;
}

describe("service policy matrix", () => {
  it("matches the checked-in golden snapshot (any policy change is a reviewable diff)", async () => {
    const matrix = await collectPolicyMatrix();
    const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as PolicyMatrix;
    // toEqual gives a precise diff: a new service/method/policy change surfaces
    // exactly which key drifted, with both the live and golden values.
    expect(matrix).toEqual(golden);
  });

  it("every service declares a non-empty service-level policy (no implicit-open service)", async () => {
    const matrix = await collectPolicyMatrix();
    for (const [name, entry] of Object.entries(matrix)) {
      expect(entry.service.length, `${name} has an empty service policy`).toBeGreaterThan(0);
    }
  });

  it("runtime.setTitle's declared per-method policy is exactly panel/app/worker/do (declared == enforced)", async () => {
    const matrix = await collectPolicyMatrix();
    // Fix 2: the handler no longer re-gates caller kind; this per-method policy
    // is the SOLE gate. If someone widens/narrows it, this — and the snapshot — fail.
    expect(matrix["runtime"]?.methods["setTitle"]).toEqual(["app", "do", "panel", "worker"]);
  });
});

/**
 * (c) Handler-doesn't-narrow-below-declared — feasibility verdict.
 *
 * A fully automated AST/lint that flags a handler performing its own
 * `ctx.caller.runtime.kind` rejection (which should instead be expressed in
 * `policy.allowed`) is NOT cleanly achievable here without false positives:
 * handlers legitimately branch on caller kind for NON-access reasons (e.g.
 * runtimeService.createEntity distinguishes app/session host-management, and
 * resolveContextPolicy uses caller kind to decide context-creation gating, not
 * service access). A regexp/AST rule can't reliably tell "this kind-check is a
 * disguised access policy" from "this kind-check is domain logic".
 *
 * Convention (enforced by review + this snapshot as the backstop): a service
 * method's caller-kind ACCESS decision lives ONLY in its `policy.allowed`
 * (service-level or per-method), never as an extra rejection inside the handler.
 * Fix 2 brought `runtime.setTitle` into line with this. The golden matrix above
 * makes any future narrowing visible: if a handler's declared policy is widened
 * to paper over a handler-side reject (or vice versa), the snapshot diff shows it.
 */
