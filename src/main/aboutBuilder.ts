/**
 * AboutBuilder - Build system for shell about pages.
 *
 * Shell pages (model-provider-config, about, keyboard-shortcuts, help) are React panels
 * that are built at app startup and served via natstack-about:// protocol.
 * They have full shell access to services via the "shell" NatstackKind.
 */

import * as esbuild from "esbuild";
import * as fs from "fs";
import * as path from "path";
import type { ShellPage, ProtocolBuildArtifacts } from "../shared/types.js";
import { storeAboutPage, hasAboutPage } from "./aboutProtocol.js";
import { PANEL_CSP_META } from "../shared/constants.js";
import { createDevLogger } from "./devLog.js";

const log = createDevLogger("AboutBuilder");
import {
  generateNodeCompatibilityPatch,
  generateAsyncTrackingBanner,
  generateModuleMapBanner,
} from "./panelBuilder.js";
import {
  getAboutPagesDir,
  getAppNodeModules,
  getPackagesDir,
  getCentralConfigDirectory,
  getPrebuiltAboutPagesDir,
} from "./paths.js";
import { DEFAULT_DEDUPE_PACKAGES, packageToRegex, parseNatstackImport, resolveExportSubpath } from "@natstack/typecheck";

/**
 * Shell page metadata for display.
 */
interface ShellPageMeta {
  page: ShellPage;
  title: string;
  description: string;
  /** If true, don't show in the "new panel" launcher (e.g., "new" itself) */
  hiddenInLauncher?: boolean;
}

/**
 * Shell page metadata - single source of truth for all shell pages.
 */
const SHELL_PAGE_META: Record<ShellPage, Omit<ShellPageMeta, "page">> = {
  "model-provider-config": {
    title: "Model Provider Config",
    description: "Configure AI model providers",
  },
  about: {
    title: "About NatStack",
    description: "Application information",
  },
  "keyboard-shortcuts": {
    title: "Keyboard Shortcuts",
    description: "View keyboard shortcuts",
  },
  help: {
    title: "Help",
    description: "Documentation and help",
  },
  new: {
    title: "New Panel",
    description: "Open a new panel",
    hiddenInLauncher: true, // Don't show "new" in the new panel launcher
  },
  adblock: {
    title: "Ad Blocking",
    description: "Configure ad blocking for browser panels",
  },
  agents: {
    title: "Agents",
    description: "Configure agent defaults and settings",
  },
  "dirty-repo": {
    title: "Uncommitted Changes",
    description: "Resolve uncommitted changes before building",
    hiddenInLauncher: true,
  },
  "git-init": {
    title: "Initialize Git Repository",
    description: "Initialize a git repository for this panel",
    hiddenInLauncher: true,
  },
};

/**
 * Get the title for a shell page.
 */
export function getShellPageTitle(page: ShellPage): string {
  return SHELL_PAGE_META[page].title;
}

/**
 * Get all shell page keys.
 * Used by aboutProtocol.ts to validate shell page names without duplicating the list.
 */
export function getShellPageKeys(): ShellPage[] {
  return Object.keys(SHELL_PAGE_META) as ShellPage[];
}

/**
 * Get all shell pages available for the launcher.
 * Excludes pages marked as hiddenInLauncher.
 */
export function getShellPagesForLauncher(): ShellPageMeta[] {
  return (Object.keys(SHELL_PAGE_META) as ShellPage[])
    .filter((page) => !SHELL_PAGE_META[page].hiddenInLauncher)
    .map((page) => ({
      page,
      ...SHELL_PAGE_META[page],
    }));
}

/**
 * Build result for an about page.
 */
interface AboutBuildResult {
  success: boolean;
  bundle?: string;
  html?: string;
  css?: string;
  error?: string;
}

/**
 * Create a plugin that resolves @natstack/* imports from the packages directory.
 *
 * The packages directory has packages at packages/<name> (e.g., packages/agentic-messaging)
 * but imports use the scoped form @natstack/<name>. Standard node resolution via nodePaths
 * can't bridge this gap, so this plugin reads each package's package.json exports to
 * resolve the correct entry point (including subpath exports like ./config).
 */
function createNatstackResolvePlugin(packagesDir: string): esbuild.Plugin {
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
          exports?: Record<string, string | Record<string, string>>;
        };

        if (pkgJson.exports) {
          const target = resolveExportSubpath(pkgJson.exports, parsed.subpath, "default");
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

/**
 * Create a plugin that deduplicates React and related packages.
 * This ensures only one copy of React is bundled, preventing the
 * "Invalid hook call" error from multiple React instances.
 */
function createDedupePlugin(nodeModulesDir: string): esbuild.Plugin {
  const resolvedNodeModules = path.resolve(nodeModulesDir);

  // Convert to regex patterns
  const patterns: RegExp[] = [];
  for (const pkg of DEFAULT_DEDUPE_PACKAGES) {
    patterns.push(packageToRegex(pkg));
  }

  return {
    name: "about-page-dedupe",
    setup(build) {
      for (const pattern of patterns) {
        build.onResolve({ filter: pattern }, async (args) => {
          // Skip if already resolving from within the target tree
          if (path.resolve(args.resolveDir).startsWith(resolvedNodeModules)) {
            return null;
          }
          // Force resolution from the app's node_modules
          try {
            const result = await build.resolve(args.path, {
              kind: args.kind,
              resolveDir: resolvedNodeModules,
            });
            if (!result.errors || result.errors.length === 0) {
              return result;
            }
          } catch {
            // Resolution failed, fall back to default resolver
          }
          return null;
        });
      }
    },
  };
}

/**
 * Builder for shell about pages.
 * Builds React pages from src/about-pages/ directory.
 */
export class AboutBuilder {
  private aboutPagesRoot: string;

  constructor() {
    // About pages are in the src/about-pages directory
    // Uses getAboutPagesDir() which handles dev vs production paths
    this.aboutPagesRoot = getAboutPagesDir();
  }

  /**
   * Build a single about page.
   */
  async buildPage(page: ShellPage): Promise<AboutBuildResult> {
    const pageDir = path.join(this.aboutPagesRoot, page);

    // Check if page directory exists
    if (!fs.existsSync(pageDir)) {
      return {
        success: false,
        error: `About page directory not found: ${pageDir}`,
      };
    }

    // Find entry point
    const entryFile = this.findEntryPoint(pageDir);
    if (!entryFile) {
      return {
        success: false,
        error: `No entry point found for about page: ${page}`,
      };
    }

    const entryPath = path.join(pageDir, entryFile);

    // Fail fast if packages directory is missing - about pages require @natstack/* packages
    const packagesDir = getPackagesDir();
    if (!packagesDir) {
      throw new Error(
        "Cannot build about pages: packages/ directory not found. " +
          "About pages require @natstack/* packages to be available."
      );
    }

    try {
      // Use writable temp dir (not asar-embedded pageDir)
      const outdir = path.join(getCentralConfigDirectory(), "about-build-cache", page);
      fs.mkdirSync(outdir, { recursive: true });

      const bundlePath = path.join(outdir, "bundle.js");

      // Build with esbuild
      // Shell pages use unsafe mode (nodeIntegration) for full service access
      // Generate compatibility banners for hybrid browser/Node.js environment
      const bannerJs = [
        generateNodeCompatibilityPatch(),
        generateAsyncTrackingBanner(),
        generateModuleMapBanner(),
      ].join("\n");

      const appNodeModules = getAppNodeModules();

      await esbuild.build({
        entryPoints: [entryPath],
        bundle: true,
        platform: "node", // Node platform for nodeIntegration
        target: "es2022",
        conditions: ["natstack-panel"],
        outfile: bundlePath,
        sourcemap: "inline",
        keepNames: true,
        format: "cjs", // CJS for nodeIntegration
        absWorkingDir: pageDir,
        nodePaths: [appNodeModules],
        // Disable tsconfig paths - the root tsconfig maps @natstack/runtime to src/index.ts
        // which is the shell entry. We need package.json exports to resolve to the panel entry.
        tsconfigRaw: "{}",
        loader: {
          ".png": "file",
          ".jpg": "file",
          ".jpeg": "file",
          ".svg": "file",
          ".ico": "file",
        },
        // JSX configuration for React components
        jsx: "automatic",
        jsxImportSource: "react",
        // Don't transform dynamic imports for shell pages
        supported: { "dynamic-import": false },
        // Compatibility banners for hybrid browser/Node.js environment
        banner: { js: bannerJs },
        metafile: true,
        plugins: [
          // Resolve @natstack/* from packages directory (handles scope-to-dir mapping + subpath exports)
          createNatstackResolvePlugin(packagesDir),
          // Deduplicate React to prevent multiple React instances
          createDedupePlugin(appNodeModules),
        ],
      });

      const bundle = fs.readFileSync(bundlePath, "utf-8");
      const cssPath = bundlePath.replace(".js", ".css");
      const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf-8") : undefined;

      // Generate HTML
      const title = SHELL_PAGE_META[page].title;
      const html = this.generateHtml(title, Boolean(css));

      // Cleanup temp directory
      try {
        fs.rmSync(outdir, { recursive: true, force: true });
      } catch {
        // Best effort cleanup
      }

      return {
        success: true,
        bundle,
        html,
        css,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Try to load a pre-built about page from the app resources.
   * Returns null if the page is not pre-built (needs runtime compilation).
   */
  private tryLoadPrebuiltPage(page: ShellPage): AboutBuildResult | null {
    const prebuiltDir = getPrebuiltAboutPagesDir();
    if (!prebuiltDir) {
      // Development mode or prebuilt pages not available
      return null;
    }

    const pageDir = path.join(prebuiltDir, page);
    const bundlePath = path.join(pageDir, "bundle.js");
    const htmlPath = path.join(pageDir, "html.html");

    // Check if required files exist
    if (!fs.existsSync(bundlePath) || !fs.existsSync(htmlPath)) {
      return null;
    }

    try {
      const bundle = fs.readFileSync(bundlePath, "utf-8");
      const html = fs.readFileSync(htmlPath, "utf-8");

      // Read CSS if present
      const cssPath = path.join(pageDir, "bundle.css");
      const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf-8") : undefined;

      console.log(`[AboutBuilder] Loaded prebuilt page: ${page}`);

      return {
        success: true,
        bundle,
        html,
        css,
      };
    } catch (error) {
      console.warn(
        `[AboutBuilder] Failed to load prebuilt page ${page}:`,
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }

  /**
   * Build and store a page for protocol serving.
   * Returns the URL for the page.
   */
  async buildAndStorePage(page: ShellPage): Promise<string> {
    // Check if already built
    if (hasAboutPage(page)) {
      log.verbose(` Page ${page} already built, reusing`);
      const { getAboutPageUrl } = await import("./aboutProtocol.js");
      return getAboutPageUrl(page);
    }

    // Try to load prebuilt page first (production builds)
    const prebuilt = this.tryLoadPrebuiltPage(page);
    if (prebuilt && prebuilt.success && prebuilt.bundle && prebuilt.html) {
      log.verbose(` Using prebuilt about page: ${page}`);
      const artifacts: ProtocolBuildArtifacts = {
        bundle: prebuilt.bundle,
        html: prebuilt.html,
        title: SHELL_PAGE_META[page].title,
        css: prebuilt.css,
        injectHostThemeVariables: true,
      };
      return storeAboutPage(page, artifacts);
    }

    // Fall back to runtime build
    log.verbose(` Building about page: ${page}`);
    const result = await this.buildPage(page);

    if (!result.success || !result.bundle || !result.html) {
      throw new Error(`Failed to build about page ${page}: ${result.error}`);
    }

    const artifacts: ProtocolBuildArtifacts = {
      bundle: result.bundle,
      html: result.html,
      title: SHELL_PAGE_META[page].title,
      css: result.css,
      injectHostThemeVariables: true,
    };

    return storeAboutPage(page, artifacts);
  }

  /**
   * Build all about pages at startup.
   */
  async buildAllPages(): Promise<void> {
    const pages = getShellPageKeys();

    for (const page of pages) {
      const pageDir = path.join(this.aboutPagesRoot, page);
      if (fs.existsSync(pageDir)) {
        try {
          await this.buildAndStorePage(page);
        } catch (error) {
          console.error(
            `[AboutBuilder] Failed to build ${page}:`,
            error instanceof Error ? error.message : String(error)
          );
        }
      }
    }
  }

  /**
   * Find entry point file in a page directory.
   */
  private findEntryPoint(pageDir: string): string | null {
    const candidates = ["index.tsx", "index.ts", "index.jsx", "index.js"];
    for (const candidate of candidates) {
      if (fs.existsSync(path.join(pageDir, candidate))) {
        return candidate;
      }
    }
    return null;
  }

  /**
   * Generate HTML template for an about page.
   */
  private generateHtml(title: string, includeCss: boolean): string {
    const cssLink = includeCss ? `\n  <link rel="stylesheet" href="./bundle.css" />` : "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  ${PANEL_CSP_META}
  <title>${title}</title>${cssLink}
  <style>
    html, body { margin: 0; padding: 0; height: 100%; }
    #root, #root > .radix-themes { min-height: 100vh; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script src="./bundle.js"></script>
</body>
</html>`;
  }
}

// Singleton instance
let instance: AboutBuilder | null = null;

/**
 * Get the singleton AboutBuilder instance.
 */
export function getAboutBuilder(): AboutBuilder {
  if (!instance) {
    instance = new AboutBuilder();
  }
  return instance;
}
