import * as fs from "fs";
import * as path from "path";
import { loadPreferences } from "./preferences.js";
import { normalizeRelativePanelPath as normalizePath } from "./pathUtils.js";

const workspaceRoot = path.resolve(process.cwd());

function normalizeRelativePanelPath(candidate: string): string {
  const { relativePath } = normalizePath(candidate, workspaceRoot);
  return relativePath;
}

function ensureDefaultRootPanelPath(): string {
  const defaultRelative = "panels/example";
  const defaultAbsolute = path.resolve(defaultRelative);

  if (fs.existsSync(defaultAbsolute)) {
    return defaultRelative;
  }

  const fallbackRelative = "panels/default-root-panel";
  const fallbackAbsolute = path.resolve(fallbackRelative);

  if (!fs.existsSync(fallbackAbsolute)) {
    fs.mkdirSync(fallbackAbsolute, { recursive: true });
  }

  return fallbackRelative;
}

function parseCliRootPanelPath(): string | undefined {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--root-panel=")) {
      const [, value] = arg.split("=");
      if (value) {
        return value;
      }
    } else if (arg === "--root-panel") {
      const index = process.argv.indexOf(arg);
      const value = process.argv[index + 1];
      if (value) {
        return value;
      }
    }
  }

  return undefined;
}

export function resolveInitialRootPanelPath(): string {
  const cliPath = parseCliRootPanelPath();
  if (cliPath) {
    try {
      return normalizeRelativePanelPath(cliPath);
    } catch (error) {
      console.warn(`Ignoring invalid CLI root panel path "${cliPath}":`, error);
    }
  }

  const prefs = loadPreferences();
  if (prefs.rootPanelPath) {
    try {
      return normalizeRelativePanelPath(prefs.rootPanelPath);
    } catch (error) {
      console.warn(`Ignoring invalid stored root panel path "${prefs.rootPanelPath}":`, error);
    }
  }

  return normalizeRelativePanelPath(ensureDefaultRootPanelPath());
}
