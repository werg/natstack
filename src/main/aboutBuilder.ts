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
import type { ShellPage, ProtocolBuildArtifacts } from "../shared/ipc/types.js";
import { storeAboutPage, hasAboutPage } from "./aboutProtocol.js";
import { PANEL_CSP_META } from "../shared/constants.js";
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
} from "./paths.js";

/**
 * Shell page titles for display in panel tree.
 */
const SHELL_PAGE_TITLES: Record<ShellPage, string> = {
  "model-provider-config": "Model Provider Config",
  about: "About NatStack",
  "keyboard-shortcuts": "Keyboard Shortcuts",
  help: "Help",
};

/**
 * Get the title for a shell page.
 */
export function getShellPageTitle(page: ShellPage): string {
  return SHELL_PAGE_TITLES[page];
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
        nodePaths: [getAppNodeModules(), packagesDir],
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
      });

      const bundle = fs.readFileSync(bundlePath, "utf-8");
      const cssPath = bundlePath.replace(".js", ".css");
      const css = fs.existsSync(cssPath) ? fs.readFileSync(cssPath, "utf-8") : undefined;

      // Generate HTML
      const title = SHELL_PAGE_TITLES[page];
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
   * Build and store a page for protocol serving.
   * Returns the URL for the page.
   */
  async buildAndStorePage(page: ShellPage): Promise<string> {
    // Check if already built
    if (hasAboutPage(page)) {
      console.log(`[AboutBuilder] Page ${page} already built, reusing`);
      const { getAboutPageUrl } = await import("./aboutProtocol.js");
      return getAboutPageUrl(page);
    }

    console.log(`[AboutBuilder] Building about page: ${page}`);
    const result = await this.buildPage(page);

    if (!result.success || !result.bundle || !result.html) {
      throw new Error(`Failed to build about page ${page}: ${result.error}`);
    }

    const artifacts: ProtocolBuildArtifacts = {
      bundle: result.bundle,
      html: result.html,
      title: SHELL_PAGE_TITLES[page],
      css: result.css,
      injectHostThemeVariables: true,
    };

    return storeAboutPage(page, artifacts);
  }

  /**
   * Build all about pages at startup.
   */
  async buildAllPages(): Promise<void> {
    const pages: ShellPage[] = ["model-provider-config", "about", "keyboard-shortcuts", "help"];

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
