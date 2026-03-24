import type * as esbuild from "esbuild";

/**
 * Framework adapter — encapsulates compilation concerns for a specific
 * component framework. Adapters are build-system code (server-side).
 *
 * Presentation concerns (CSS framework, HTML shell) live in workspace
 * templates, not here. The adapter's cdnStylesheets/additionalCss/rootElementHtml
 * are only used as a last-resort fallback when no template is available.
 */
export interface FrameworkAdapter {
  readonly id: string;

  /** Packages to deduplicate across chunks (e.g., react, react-dom) */
  readonly dedupePackages: readonly string[];

  /** Packages to force-split into separate chunks */
  readonly forcedSplitPackages: readonly string[];

  /** esbuild jsx mode */
  readonly jsx?: "automatic" | "preserve" | "transform";

  /** esbuild tsconfigRaw compilerOptions.jsx value (e.g., "react-jsx") */
  readonly tsconfigJsx?: "preserve" | "react" | "react-jsx" | "react-native" | "react-jsxdev";

  /** Additional esbuild plugins (e.g., svelte compiler) */
  readonly plugins?: () => esbuild.Plugin[];

  /** Generate the entry wrapper that imports the user module and mounts it */
  generateEntry(exposeEntryFile: string, entryFile: string): string;

  // --- Fallback HTML generation (only used when no template HTML is found) ---

  /** CDN stylesheets to inject in default HTML <head> */
  readonly cdnStylesheets?: readonly string[];

  /** Extra CSS rules for default HTML <style> */
  readonly additionalCss?: string;

  /** Root element HTML for <body> */
  readonly rootElementHtml?: string;
}
