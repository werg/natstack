/**
 * Template resolution — determines framework and HTML shell for panel builds.
 *
 * Resolves both concerns in one pass from extracted source (ref-correct):
 * - htmlPath: which HTML shell to use (panel's own, template's, or null for adapter fallback)
 * - framework: which compiler adapter to use ("react", "svelte", "vanilla", etc.)
 */

import * as fs from "fs";
import * as path from "path";

export interface TemplateConfig {
  framework?: string;
}

export interface ResolvedTemplate {
  /** Path to the template index.html, or null if adapter should generate fallback */
  htmlPath: string | null;
  /** Resolved framework ID */
  framework: string;
}

/**
 * Resolve template HTML and framework for a panel from extracted source.
 *
 * HTML resolution: panel index.html → named template → default template → null
 * Framework resolution: template config → dep auto-detection → "vanilla"
 *
 * A panel with its own index.html is self-contained — the default template's
 * framework does not bleed in. Only an explicit template reference or dep
 * auto-detection determines the framework.
 */
export function resolveTemplate(
  manifest: { template?: string },
  dependencies: Record<string, string>,
  panelSourcePath: string,
  sourceRoot: string,
): ResolvedTemplate {
  // Panel has its own index.html — self-contained
  const panelHtml = path.join(panelSourcePath, "index.html");
  if (fs.existsSync(panelHtml)) {
    // Only use template framework if explicitly referenced
    const templateFramework = manifest.template
      ? readTemplateFramework(sourceRoot, manifest.template)
      : null;
    return {
      htmlPath: panelHtml,
      framework: templateFramework ?? detectFrameworkFromDeps(dependencies),
    };
  }

  // Explicit template reference
  if (manifest.template) {
    const templateDir = path.join(sourceRoot, "templates", manifest.template);
    return {
      htmlPath: findHtml(templateDir),
      framework: readTemplateFramework(sourceRoot, manifest.template) ?? detectFrameworkFromDeps(dependencies),
    };
  }

  // Implicit default template
  const defaultDir = path.join(sourceRoot, "templates", "default");
  const defaultHtml = findHtml(defaultDir);
  if (defaultHtml) {
    return {
      htmlPath: defaultHtml,
      framework: readTemplateFramework(sourceRoot, "default") ?? detectFrameworkFromDeps(dependencies),
    };
  }

  // No template at all — vanilla fallback
  return {
    htmlPath: null,
    framework: detectFrameworkFromDeps(dependencies),
  };
}

function findHtml(templateDir: string): string | null {
  const htmlPath = path.join(templateDir, "index.html");
  return fs.existsSync(htmlPath) ? htmlPath : null;
}

function readTemplateFramework(sourceRoot: string, templateName: string): string | null {
  const configPath = path.join(sourceRoot, "templates", templateName, "template.json");
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as TemplateConfig;
    return config.framework ?? null;
  } catch {
    return null;
  }
}

function detectFrameworkFromDeps(dependencies: Record<string, string>): string {
  if ("@workspace/react" in dependencies) return "react";
  if ("@workspace/svelte" in dependencies) return "svelte";
  return "vanilla";
}
