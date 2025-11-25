import * as fs from "fs";
import * as path from "path";
import { getCentralConfigDirectory } from "./paths.js";
import { validateRelativePath } from "./pathUtils.js";

export interface Preferences {
  rootPanelPath?: string;
}

function getPreferencesPath(): string {
  const configDir = getCentralConfigDirectory();
  return path.join(configDir, "preferences.json");
}

export function loadPreferences(): Preferences {
  try {
    const data = fs.readFileSync(getPreferencesPath(), "utf-8");
    return JSON.parse(data) as Preferences;
  } catch {
    return {};
  }
}

export function savePreferences(prefs: Preferences): void {
  const filePath = getPreferencesPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(prefs, null, 2));
}

export function setRootPanelPreference(rootPanelPath: string): void {
  try {
    const normalized = validateRelativePath(rootPanelPath);
    const prefs = loadPreferences();
    prefs.rootPanelPath = normalized;
    savePreferences(prefs);
  } catch (error) {
    console.error("Failed to set root panel preference:", error);
  }
}
