/**
 * Pre-bundle @natstack/* packages for injection into panel runtime
 *
 * This script creates browser-compatible ESM bundles of workspace packages
 * that can be used by the in-panel build system (@natstack/build).
 *
 * Output: dist/prebundled-packages.json
 * Format: { "@natstack/panel": "..bundle code..", ... }
 */

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, "..");
const require = createRequire(import.meta.url);

/**
 * @natstack packages to pre-bundle for panel runtime
 */
const NATSTACK_PACKAGES = [
  "@natstack/panel",
  "@natstack/react",
  "@natstack/core",
  "@natstack/ai",
  "@natstack/git",
];

/**
 * Third-party packages that must be available in the panel runtime.
 * ZenFS is bundled to avoid CDN incompatibilities (missing exports).
 * TypeScript is bundled for in-panel type checking.
 */
const THIRD_PARTY_PACKAGES = [
  "@zenfs/core",
  "@zenfs/core/promises",
  "@zenfs/dom",
  "typescript", // For in-panel type checking
];

/**
 * External dependencies that should NOT be bundled
 * (they'll be resolved via CDN at panel build time)
 *
 * React is loaded from CDN to ensure a single instance across all panels
 * (both prebundled @natstack packages and dynamically built child panels)
 */
const EXTERNAL_DEPS = [
  // React packages - loaded from CDN for single-instance guarantee
  "react",
  "react-dom",
  "react-dom/client",
  "react/jsx-runtime",
  // Other CDN dependencies
  "@radix-ui/themes",
  "ai",
  // Git operations (large library, better loaded from CDN)
  "isomorphic-git",
];

/**
 * Bundle a @natstack package from workspace
 */
async function bundleNatstackPackage(packageName) {
  const packagePath = packageName.replace("@natstack/", "");
  const entryPoint = path.join(rootDir, "packages", packagePath, "dist", "index.js");

  if (!fs.existsSync(entryPoint)) {
    console.warn(`  Skipping ${packageName}: dist/index.js not found`);
    return null;
  }

  try {
    const result = await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      minify: true,
      external: [
        ...EXTERNAL_DEPS,
        // Don't bundle other @natstack packages - they'll be resolved separately
        ...NATSTACK_PACKAGES.filter(p => p !== packageName),
      ],
      // Handle Node.js built-ins that might be referenced
      define: {
        "process.env.NODE_ENV": '"production"',
      },
    });

    const code = result.outputFiles[0].text;
    console.log(`  Bundled ${packageName}: ${(code.length / 1024).toFixed(1)}KB`);
    return code;
  } catch (error) {
    console.error(`  Failed to bundle ${packageName}:`, error.message);
    return null;
  }
}

/**
 * Bundle a third-party package from node_modules
 */
async function bundleNodePackage(packageName) {
  let entryPoint;
  try {
    // Resolve package entry via package.json exports
    entryPoint = require.resolve(packageName);
  } catch (error) {
    console.warn(`  Skipping ${packageName}: unable to resolve entry point (${error.message})`);
    return null;
  }

  try {
    const result = await esbuild.build({
      entryPoints: [entryPoint],
      bundle: true,
      format: "esm",
      platform: "browser",
      target: "es2022",
      write: false,
      minify: true,
      external: [
        ...EXTERNAL_DEPS,
        ...NATSTACK_PACKAGES,
        ...THIRD_PARTY_PACKAGES.filter((p) => p !== packageName),
      ],
      define: {
        "process.env.NODE_ENV": '"production"',
      },
    });

    const code = result.outputFiles[0].text;
    console.log(`  Bundled ${packageName}: ${(code.length / 1024).toFixed(1)}KB`);
    return code;
  } catch (error) {
    console.error(`  Failed to bundle ${packageName}:`, error.message);
    return null;
  }
}

// Size limits and warnings
// Increased to accommodate TypeScript (~3.5MB) for in-panel type checking
const MAX_TOTAL_SIZE = 5 * 1024 * 1024; // 5MB total (was 2MB)
const MAX_SINGLE_PACKAGE_SIZE = 4 * 1024 * 1024; // 4MB per package (was 500KB)
const WARN_TOTAL_SIZE = 4 * 1024 * 1024; // Warn at 4MB (was 1.5MB)

/**
 * Format bytes as human-readable string
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}

async function main() {
  console.log("Pre-bundling packages for panel runtime...\n");

  const bundles = {
    core: {}, // Essential packages - always loaded
    optional: {}, // Optional packages - can be loaded on demand
  };

  // Bundle @natstack packages (core)
  // Note: React is NOT prebundled - it's loaded from CDN to ensure single instance
  console.log("Bundling @natstack packages (core):");
  for (const packageName of NATSTACK_PACKAGES) {
    const code = await bundleNatstackPackage(packageName);
    if (code) {
      bundles.core[packageName] = code;

      // Warn if package is too large
      if (code.length > MAX_SINGLE_PACKAGE_SIZE) {
        console.warn(
          `  WARNING: ${packageName} is ${formatBytes(code.length)} ` +
          `(exceeds ${formatBytes(MAX_SINGLE_PACKAGE_SIZE)} limit)`
        );
      }
    }
  }

  // Bundle required third-party packages (optional - can be lazy-loaded)
  console.log("\nBundling third-party packages (lazy-loadable):");
  for (const packageName of THIRD_PARTY_PACKAGES) {
    const code = await bundleNodePackage(packageName);
    if (code) {
      bundles.optional[packageName] = code;

      if (code.length > MAX_SINGLE_PACKAGE_SIZE) {
        console.warn(
          `  WARNING: ${packageName} is ${formatBytes(code.length)} ` +
          `(exceeds ${formatBytes(MAX_SINGLE_PACKAGE_SIZE)} limit)`
        );
      }
    }
  }

  // Calculate total sizes
  const coreSize = Object.values(bundles.core).reduce((sum, code) => sum + code.length, 0);
  const optionalSize = Object.values(bundles.optional).reduce((sum, code) => sum + code.length, 0);
  const totalSize = coreSize + optionalSize;

  console.log(`\n${'='.repeat(60)}`);
  console.log('Prebundled Package Summary:');
  console.log(`${'='.repeat(60)}`);
  console.log(`Core packages:     ${Object.keys(bundles.core).length} (${formatBytes(coreSize)})`);
  console.log(`Optional packages: ${Object.keys(bundles.optional).length} (${formatBytes(optionalSize)})`);
  console.log(`Total size:        ${formatBytes(totalSize)}`);
  console.log(`${'='.repeat(60)}`);

  // Check size limits
  if (totalSize > MAX_TOTAL_SIZE) {
    console.error(
      `\nERROR: Total prebundled size ${formatBytes(totalSize)} exceeds ` +
      `limit of ${formatBytes(MAX_TOTAL_SIZE)}!`
    );
    console.error('Consider moving large packages to optional or external dependencies.');
    process.exit(1);
  } else if (totalSize > WARN_TOTAL_SIZE) {
    console.warn(
      `\nWARNING: Total prebundled size ${formatBytes(totalSize)} is approaching ` +
      `limit of ${formatBytes(MAX_TOTAL_SIZE)}`
    );
  }

  // Calculate version hash from all package versions
  const packageVersions = {};

  // Read versions from @natstack packages
  for (const packageName of NATSTACK_PACKAGES) {
    const packagePath = packageName.replace("@natstack/", "");
    const pkgJsonPath = path.join(rootDir, "packages", packagePath, "package.json");
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      packageVersions[packageName] = pkgJson.version ?? "0.0.0";
    } catch {
      packageVersions[packageName] = "0.0.0";
    }
  }

  // Read versions from third-party packages
  for (const packageName of THIRD_PARTY_PACKAGES) {
    try {
      const pkgJsonPath = require.resolve(`${packageName}/package.json`);
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, "utf-8"));
      packageVersions[packageName] = pkgJson.version ?? "0.0.0";
    } catch {
      packageVersions[packageName] = "0.0.0";
    }
  }

  // Create version hash
  const versionString = JSON.stringify(packageVersions, Object.keys(packageVersions).sort());
  const versionHash = crypto.createHash("sha256").update(versionString).digest("hex").slice(0, 16);

  console.log(`\nVersion hash: ${versionHash}`);

  // Create manifest with versioning
  const manifest = {
    version: versionHash,
    timestamp: new Date().toISOString(),
    packageVersions,
    bundles,
  };

  // Write output with versioning
  const outputPath = path.join(rootDir, "dist", "prebundled-packages.json");
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(manifest, null, 2));

  console.log(`Wrote prebundled packages to ${outputPath}`);

  // Also create a TypeScript-friendly version as a module
  const moduleOutput = `// Auto-generated by scripts/prebundle-packages.mjs
// Do not edit manually

export interface PrebundledPackages {
  /** Core packages - always loaded */
  core: Record<string, string>;
  /** Optional packages - lazy-loaded on demand */
  optional: Record<string, string>;
}

export interface PrebundledManifest {
  /** Version hash - changes when any package version changes */
  version: string;
  /** Build timestamp */
  timestamp: string;
  /** Package versions used in this build */
  packageVersions: Record<string, string>;
  /** Bundled package code */
  bundles: PrebundledPackages;
}

export const PREBUNDLED_MANIFEST: PrebundledManifest = ${JSON.stringify(manifest)};

// Export bundles for backwards compatibility
export const PREBUNDLED_PACKAGES: PrebundledPackages = PREBUNDLED_MANIFEST.bundles;

export default PREBUNDLED_MANIFEST;
`;

  const moduleOutputPath = path.join(rootDir, "dist", "prebundled-packages.ts");
  fs.writeFileSync(moduleOutputPath, moduleOutput);
  console.log(`Wrote TypeScript module to ${moduleOutputPath}`);
}

main().catch(console.error);
