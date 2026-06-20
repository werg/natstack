/**
 * Frontmatter-declared dependency prefetcher.
 *
 * When a document's frontmatter `dependencies:` block changes we eagerly
 * load each new entry through the panel sandbox so that:
 *
 *   - inline JSX in the doc (rendered by `LiveJsxEditor`) can import the
 *     package immediately
 *   - Preview-mode compilation has the package already cached in the
 *     panel's module map (`__natstackModuleMap__`)
 *
 * Internally calls `executeSandbox` with a no-op body and the `imports`
 * field, which is the public API that triggers `loadImports` → bundle
 * fetch → module-map registration. Failures are logged but never thrown
 * — a missing or mistyped dependency shouldn't take down the editor; the
 * user sees a compile error at the consuming JSX boundary instead.
 */

import { executeSandbox } from "@workspace/eval";
import type { SandboxConfig } from "@workspace/agentic-core";

// In-flight dedupe is scoped per sandbox via a WeakMap on the SandboxConfig
// identity. Within one panel realm the SandboxConfig is typically a
// useMemo'd singleton, so this works exactly like a module-level Map; but
// if a future caller swaps the sandbox (e.g. on a credential change),
// the new sandbox gets its own dedupe cache so we don't skip a prefetch
// just because the OLD sandbox already saw the same fingerprint.
const inFlightBySandbox = new WeakMap<SandboxConfig, Map<string, Promise<void>>>();

function fingerprint(deps: Record<string, string>): string {
  return Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}@${v}`).join(",");
}

function inFlightFor(sandbox: SandboxConfig): Map<string, Promise<void>> {
  let m = inFlightBySandbox.get(sandbox);
  if (!m) {
    m = new Map();
    inFlightBySandbox.set(sandbox, m);
  }
  return m;
}

export async function prefetchDependencies(
  sandbox: SandboxConfig,
  deps: Record<string, string>,
  onLog?: (line: string) => void,
): Promise<void> {
  if (Object.keys(deps).length === 0) return;
  const inFlight = inFlightFor(sandbox);
  const key = fingerprint(deps);
  const existing = inFlight.get(key);
  if (existing) return existing;
  const task = (async () => {
    try {
      onLog?.(`[spectrolite] prefetching deps: ${Object.keys(deps).join(", ")}`);
      const result = await executeSandbox(";", {
        syntax: "tsx",
        imports: deps,
        loadImport: sandbox.loadImport,
      });
      if (!result.success) {
        onLog?.(`[spectrolite] dep prefetch reported failure: ${result.error}`);
      }
    } catch (err) {
      onLog?.(`[spectrolite] dep prefetch threw: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, task);
  return task;
}
