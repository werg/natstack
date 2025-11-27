import type { DependencyResolver, FrameworkPreset } from "./types.js";
import type { EsbuildPlugin } from "./browser-builder.js";
import { CDN_BASE_URLS, CDN_DEFAULTS, REACT_PRESET, getImportMapPackages } from "./types.js";
import { getPrebundledRegistry } from "./prebundled.js";

/**
 * Packages that should be marked as external (loaded at runtime)
 * because they're provided by the panel runtime
 */
const RUNTIME_EXTERNAL = new Set([
  "fs",
  "fs/promises",
  "node:fs",
  "node:fs/promises",
]);

/**
 * Parse a package specifier into name and subpath
 * e.g., "lodash/fp" -> { name: "lodash", subpath: "/fp" }
 * e.g., "@scope/pkg/sub" -> { name: "@scope/pkg", subpath: "/sub" }
 */
function parsePackageSpecifier(specifier: string): {
  name: string;
  subpath: string;
} {
  if (specifier.startsWith("@")) {
    // Scoped package
    const parts = specifier.split("/");
    if (parts.length >= 2) {
      return {
        name: `${parts[0]}/${parts[1]}`,
        subpath: parts.length > 2 ? "/" + parts.slice(2).join("/") : "",
      };
    }
  } else {
    const slashIndex = specifier.indexOf("/");
    if (slashIndex > 0) {
      return {
        name: specifier.slice(0, slashIndex),
        subpath: specifier.slice(slashIndex),
      };
    }
  }
  return { name: specifier, subpath: "" };
}

/**
 * Options for the CDN resolver plugin
 */
export interface CdnResolverOptions {
  /** CDN base URL for npm packages */
  cdnBaseUrl?: string;
  /** Framework preset for import map packages */
  preset?: FrameworkPreset;
  /** Runtime modules (fs, etc.) provided by the panel runtime */
  runtimeModules?: Map<string, string>;
}

/**
 * Create an esbuild plugin that resolves npm dependencies via CDN
 */
export function createCdnResolverPlugin(
  resolver: DependencyResolver,
  runtimeModules?: Map<string, string>,
  preset: FrameworkPreset = REACT_PRESET
): EsbuildPlugin {
  const cdnBaseUrl = resolver.cdnBaseUrl ?? CDN_BASE_URLS.ESM_SH;

  // Get import map packages from preset
  const importMapPackages = getImportMapPackages(preset);

  // Get prebundled packages from global registry
  const registry = getPrebundledRegistry();

  // Helper to check prebundled from global registry
  const getPrebundledContent = (name: string): string | undefined => {
    return registry.get(name);
  };

  const hasPrebundled = (name: string): boolean => {
    return registry.has(name);
  };

  return {
    name: "cdn-resolver",
    setup(build) {
      // Handle runtime modules (fs, etc.) - these are provided by the panel runtime
      build.onResolve({ filter: /^(node:)?(fs|fs\/promises)$/ }, (args) => {
        if (runtimeModules?.has(args.path)) {
          return {
            path: runtimeModules.get(args.path)!,
            external: false,
          };
        }
        // Inline a thin wrapper that forwards to @zenfs/core so the configured instance is shared
        return { path: args.path, namespace: "runtime-fs" };
      });

      // Handle @natstack/* packages - should be pre-bundled
      build.onResolve({ filter: /^@natstack\// }, (args) => {
        if (hasPrebundled(args.path)) {
          // Return as inline content via namespace
          return {
            path: args.path,
            namespace: "prebundled",
          };
        }
        // If not prebundled, try CDN as fallback
        console.warn(
          `@natstack package "${args.path}" not found in prebundled modules, falling back to CDN`
        );
        return {
          path: `${cdnBaseUrl}/${args.path}`,
          external: true,
        };
      });

      // Handle @zenfs/* packages
      build.onResolve({ filter: /^@zenfs\// }, (args) => {
        if (hasPrebundled(args.path)) {
          return {
            path: args.path,
            namespace: "prebundled",
          };
        }
        // ZenFS should ideally be prebundled, but fall back to CDN
        return {
          path: `${cdnBaseUrl}/${args.path}`,
          external: true,
        };
      });

      // Handle all other bare imports (npm packages)
      build.onResolve({ filter: /^[^./]/ }, (args) => {
        // Skip if already handled
        if (
          args.path.startsWith("@natstack/") ||
          args.path.startsWith("@zenfs/") ||
          RUNTIME_EXTERNAL.has(args.path)
        ) {
          return null;
        }

        const { name, subpath } = parsePackageSpecifier(args.path);

        // Check if package is in the import map - keep as bare import
        // The browser's import map will resolve these at runtime
        if (importMapPackages.has(args.path) || importMapPackages.has(name)) {
          return {
            path: args.path,
            external: true,
          };
        }

        // Check if it's in prebundled
        if (hasPrebundled(name)) {
          return {
            path: args.path,
            namespace: "prebundled",
          };
        }

        // Resolve via CDN URL for everything else
        // esm.sh format: https://esm.sh/package@version/subpath
        const cdnUrl = `${cdnBaseUrl}/${name}${subpath}`;
        return {
          path: cdnUrl,
          external: true,
        };
      });

      // Load prebundled modules
      build.onLoad({ filter: /.*/, namespace: "prebundled" }, (args) => {
        const content = getPrebundledContent(args.path);
        if (content) {
          return {
            contents: content,
            loader: "js",
          };
        }
        // Try without version suffix
        const { name } = parsePackageSpecifier(args.path);
        const baseContent = getPrebundledContent(name);
        if (baseContent) {
          return {
            contents: baseContent,
            loader: "js",
          };
        }
        return {
          errors: [{ text: `Prebundled module not found: ${args.path}` }],
        };
      });

      // Provide runtime fs wrappers that forward to the bundled @zenfs/core instance
      build.onLoad({ filter: /.*/, namespace: "runtime-fs" }, (args) => {
        const isPromises = args.path.includes("promises");
        const source = isPromises
          ? `
import { promises as defaultPromises } from "@zenfs/core";
export * from "@zenfs/core/promises";
export default defaultPromises;
`
          : `
import { fs as defaultFs } from "@zenfs/core";
export * from "@zenfs/core";
export default defaultFs;
`;

        return { contents: source, loader: "js" };
      });
    },
  };
}

/**
 * Get CDN URL for a package
 */
export function getCdnUrl(
  packageName: string,
  version?: string,
  cdnBase: string = CDN_DEFAULTS.ESM_SH
): string {
  const { name, subpath } = parsePackageSpecifier(packageName);
  const versionSuffix = version ? `@${version}` : "";
  return `${cdnBase}/${name}${versionSuffix}${subpath}`;
}
