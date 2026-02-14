/**
 * Shared esbuild plugin for resolving @natstack/* imports from the packages directory.
 *
 * The packages directory has packages at packages/<name> (e.g., packages/agentic-messaging)
 * but imports use the scoped form @natstack/<name>. Standard node resolution via nodePaths
 * can't bridge this gap, so this plugin reads each package's package.json exports to
 * resolve the correct entry point (including subpath exports like ./config).
 */

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import { parseNatstackImport, resolveExportSubpath, BUNDLE_CONDITIONS } from "@natstack/typecheck";

export function createNatstackResolvePlugin(
  packagesDir: string,
  conditions: readonly string[] = BUNDLE_CONDITIONS,
): esbuild.Plugin {
  return {
    name: "natstack-packages",
    setup(build) {
      build.onResolve({ filter: /^@natstack\// }, (args) => {
        const parsed = parseNatstackImport(args.path);
        if (!parsed) return null;

        const pkgDir = path.join(packagesDir, parsed.packageName);
        const pkgJsonPath = path.join(pkgDir, "package.json");
        if (!fs.existsSync(pkgJsonPath)) return null;

        const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8")) as {
          main?: string;
          exports?: Record<string, unknown>;
        };

        if (pkgJson.exports) {
          const target = resolveExportSubpath(pkgJson.exports, parsed.subpath, conditions);
          if (target) return { path: path.resolve(pkgDir, target) };
        }

        // Fallback to main field for root import
        if (parsed.subpath === "." && pkgJson.main) {
          return { path: path.resolve(pkgDir, pkgJson.main) };
        }

        return null;
      });
    },
  };
}
