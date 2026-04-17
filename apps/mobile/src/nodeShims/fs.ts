// `fs` stub for mobile bundles. Code paths that reach these functions (e.g.
// `loadPanelManifest` in @natstack/shared/panelTypes) are server-only and
// should never execute on mobile. Throwing makes that contract explicit rather
// than silently returning wrong results.

function notAvailable(name: string): never {
  throw new Error(`fs.${name} is not available on mobile; this code path should not run in the RN bundle`);
}

export function existsSync(): boolean {
  return notAvailable("existsSync");
}

export function readFileSync(): string {
  return notAvailable("readFileSync");
}

export function writeFileSync(): void {
  return notAvailable("writeFileSync");
}

export function statSync(): never {
  return notAvailable("statSync");
}

export function mkdirSync(): never {
  return notAvailable("mkdirSync");
}

export function readdirSync(): never {
  return notAvailable("readdirSync");
}

export default { existsSync, readFileSync, writeFileSync, statSync, mkdirSync, readdirSync };
