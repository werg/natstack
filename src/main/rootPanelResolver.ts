import * as fs from "fs";
import * as path from "path";
import { loadPreferences } from "./preferences.js";
import { getStateDirectory } from "./paths.js";

function ensureDefaultRootPanelPath(): string {
  const stateDir = getStateDirectory();
  const defaultPanelDir = path.join(stateDir, "Default Root Panel");
  const manifestPath = path.join(defaultPanelDir, "panel.json");

  if (!fs.existsSync(manifestPath)) {
    fs.rmSync(defaultPanelDir, { recursive: true, force: true });
    fs.mkdirSync(defaultPanelDir, { recursive: true });

    const templateSource = path.resolve("panels/example");
    if (fs.existsSync(templateSource)) {
      fs.cpSync(templateSource, defaultPanelDir, { recursive: true });
    }
  }

  return defaultPanelDir;
}

function parseCliRootPanelPath(): string | undefined {
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith("--root-panel=")) {
      const [, value] = arg.split("=");
      if (value) {
        return path.resolve(value);
      }
    } else if (arg === "--root-panel") {
      const index = process.argv.indexOf(arg);
      const value = process.argv[index + 1];
      if (value) {
        return path.resolve(value);
      }
    }
  }

  return undefined;
}

export function resolveInitialRootPanelPath(): string {
  const cliPath = parseCliRootPanelPath();
  if (cliPath) {
    return cliPath;
  }

  const prefs = loadPreferences();
  if (prefs.rootPanelPath) {
    return path.resolve(prefs.rootPanelPath);
  }

  return ensureDefaultRootPanelPath();
}
