import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Guard: no workspace package may grab a host module via the per-isolate global
 * `globalThis["__natstackRequire__"]`.
 *
 * That's the PANEL convention — panels keep host modules (incl.
 * `@workspace/runtime`) in a per-isolate global module map. The eval sandbox is
 * a workerd DO that keeps each owner's runtime in a PER-OBJECT map (so owners
 * sharing an isolate can't leak runtimes into each other), so a global grab of
 * `@workspace/runtime` silently misses there — the `@workspace/panel-browser`
 * bug. Resolve host modules through a normal import instead: the build
 * externalizes it and the bundle's own `require` maps to the right host (the
 * global singleton in a panel, the per-object map in eval).
 *
 * The allowlist is the EXHAUSTIVE set of files that legitimately touch the
 * global require: the sandbox engine that IMPLEMENTS it, a shim that INSTALLS
 * it, and a panel-only lazy library loader (sync fast-path for an already-loaded
 * shared module, NOT a per-owner runtime grab). Any NEW entry must be justified
 * here — that review is the whole point of the guard.
 */
const ALLOWLIST = new Set([
  "eval/src/sandbox.ts", // sandbox engine — implements the require
  "eval/src/execute.ts", // sandbox engine — implements the require
  "agentic-core/src/message-type-doctor.ts", // installs a shim require (diagnostics/util)
  "runtime/src/panel/cdpAutomation.ts", // panel-only lazy cdp-client loader (sync fast-path; cdp-client lives in the shared global map, not per-owner)
]);

// The property-ACCESS form, `(...)["__natstackRequire__"]` — deliberately NOT a
// bare `__natstackRequire__` mention, so prose comments and error-message
// strings that name the symbol don't trip the guard.
const ACCESS = /\[\s*['"]__natstackRequire__['"]\s*\]/;

const PACKAGES_ROOT = path.join(process.cwd(), "workspace", "packages");

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) tsFiles(full, out);
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("host-global access guard", () => {
  it("workspace packages resolve host modules via imports, not globalThis.__natstackRequire__", () => {
    const offenders: string[] = [];
    for (const file of tsFiles(PACKAGES_ROOT)) {
      const rel = path.relative(PACKAGES_ROOT, file);
      if (ALLOWLIST.has(rel)) continue;
      if (ACCESS.test(fs.readFileSync(file, "utf-8"))) offenders.push(rel);
    }
    expect(
      offenders,
      `These workspace packages reach for the global \`__natstackRequire__\` to resolve a host ` +
        `module — that breaks in the eval/DO per-object module map. Use a normal import instead ` +
        `(see @workspace/panel-browser). If the use is genuinely legitimate, add it to ALLOWLIST ` +
        `with a justification:\n  ${offenders.join("\n  ")}`
    ).toEqual([]);
  });

  it("the allowlist has no stale entries (each still exists and still accesses it)", () => {
    const stale: string[] = [];
    for (const rel of ALLOWLIST) {
      const full = path.join(PACKAGES_ROOT, rel);
      if (!fs.existsSync(full) || !ACCESS.test(fs.readFileSync(full, "utf-8"))) stale.push(rel);
    }
    expect(
      stale,
      `These ALLOWLIST entries no longer access the global require — remove them so the ` +
        `allowlist stays an accurate record:\n  ${stale.join("\n  ")}`
    ).toEqual([]);
  });
});
