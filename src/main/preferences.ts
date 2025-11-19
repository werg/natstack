import * as fs from "fs";
import * as path from "path";
import { getStateDirectory } from "./paths.js";

export interface Preferences {
  rootPanelPath?: string;
}

function getPreferencesPath(): string {
  const stateDir = getStateDirectory();
  return path.join(stateDir, "preferences.json");
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
  const prefs = loadPreferences();
  prefs.rootPanelPath = rootPanelPath;
  savePreferences(prefs);
}
