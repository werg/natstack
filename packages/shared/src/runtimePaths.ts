import * as fs from "fs";
import * as path from "path";

export interface RuntimeLayout {
  appRoot: string;
  appUnpackedRoot: string;
  resourcesRoot: string;
}

function dedupePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const p of paths) {
    const resolved = path.resolve(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(p);
  }
  return result;
}

export function createRuntimeLayout(appRoot: string): RuntimeLayout {
  const appUnpackedRoot = appRoot.replace(/\.asar$/, ".asar.unpacked");
  const resourcesRoot =
    appRoot.endsWith(".asar")
      ? typeof process.resourcesPath === "string"
        ? process.resourcesPath
        : path.dirname(appRoot)
      : appRoot;

  return {
    appRoot,
    appUnpackedRoot,
    resourcesRoot,
  };
}

export function getPhysicalAppPath(appRoot: string, relativePath: string): string {
  return path.join(createRuntimeLayout(appRoot).appUnpackedRoot, relativePath);
}

export function getPhysicalPathForAsarPath(filePath: string): string {
  return filePath.replace(/\.asar([/\\])/, ".asar.unpacked$1");
}

export function getExistingAppNodeModulesRoots(appRoot: string): string[] {
  const layout = createRuntimeLayout(appRoot);
  const candidates = [
    path.join(layout.appUnpackedRoot, "node_modules"),
    path.join(layout.appRoot, "node_modules"),
  ];
  // When installed via npm (e.g. <prefix>/node_modules/@natstack/app), the
  // package's own dependencies are hoisted to an ancestor node_modules rather
  // than nested under the package directory. Walk ancestors and include every
  // node_modules dir — mirroring Node's own module resolution — so runtime
  // panel/worker builds resolve host-provided deps wherever npm hoisted them.
  // (Harmless for the dev monorepo, where appRoot already owns node_modules.)
  let dir = layout.appRoot;
  for (let depth = 0; depth < 12; depth++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    candidates.push(path.join(parent, "node_modules"));
    dir = parent;
  }
  return dedupePaths(candidates).filter((p) => fs.existsSync(p));
}

export function getWorkspaceTemplateCandidates(appRoot: string): string[] {
  const layout = createRuntimeLayout(appRoot);
  return dedupePaths([
    path.join(layout.resourcesRoot, "workspace-template"),
    path.join(layout.appRoot, "workspace"),
  ]);
}

export function getExistingWorkspaceTemplateDir(
  appRoot: string,
  configFile: string,
): string | null {
  for (const candidate of getWorkspaceTemplateCandidates(appRoot)) {
    if (fs.existsSync(path.join(candidate, configFile))) {
      return candidate;
    }
  }
  return null;
}

export function getPlatformPackageBinaryPath(
  appRoot: string,
  packageName: string,
  binaryName: string,
): string {
  return getPhysicalAppPath(
    appRoot,
    path.join("node_modules", ...packageName.split("/"), "bin", binaryName),
  );
}
