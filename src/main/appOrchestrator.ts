import { createDevLogger } from "@natstack/dev-log";
import * as fs from "node:fs";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import type { PanelViewLike } from "@natstack/shared/panelInterfaces";
import type { AppCapability } from "@natstack/shared/unitManifest";

const log = createDevLogger("AppOrchestrator");

export const ELECTRON_APP_HOST_CAPABILITIES = [
  "native-menus",
  "notifications",
  "open-external",
  "window-management",
  "panel-hosting",
  "incoming-pair-links",
  "connection-management",
  "fs-read",
  "fs-write",
] as const satisfies readonly AppCapability[];

const electronAppHostCapabilitySet = new Set<AppCapability>(ELECTRON_APP_HOST_CAPABILITIES);

export interface AppAvailableEvent {
  appId: string;
  source?: string;
  target?: "electron" | "react-native" | "terminal";
  launchMode?: "hosted-view" | "native-bootstrap" | "artifact-only";
  url: string;
  contextId?: string | null;
  capabilities?: readonly AppCapability[];
  effectiveVersion?: string | null;
  buildKey?: string | null;
  adoptionPolicy?: "immediate" | "prompt" | "artifact-only";
}

export interface AppOrchestratorDeps {
  getPanelView(): PanelViewLike | null;
  statePath?: string;
}

interface BakedAppManifest {
  version: 1;
  app: {
    name: string;
    source: string;
    target: "electron" | "react-native" | "terminal";
    capabilities?: AppCapability[];
  };
  build: {
    effectiveVersion: string;
  };
  artifacts: Array<{
    path: string;
    role: string;
  }>;
}

export class AppOrchestrator {
  private readonly adopted = new Map<string, AppAvailableEvent>();
  private readonly pending = new Map<string, AppAvailableEvent>();

  constructor(private readonly deps: AppOrchestratorDeps) {
    this.loadPendingState();
  }

  async applyAppAvailable(event: AppAvailableEvent): Promise<void> {
    if (event.target && event.target !== "electron") {
      log.verbose(`Ignoring non-Electron app ${event.appId} for Electron host: ${event.target}`);
      return;
    }
    if (event.adoptionPolicy === "artifact-only") {
      log.verbose(`Ignoring artifact-only app ${event.appId} for Electron host`);
      return;
    }
    this.validateElectronApp(event);
    const panelView = this.requirePanelView();
    const current = this.adopted.get(event.appId);
    const hasLoadedView = panelView.hasView?.(event.appId) ?? false;
    const isNewBuild = !current || appAvailableIdentity(current) !== appAvailableIdentity(event);
    if (event.adoptionPolicy === "prompt" && hasLoadedView && isNewBuild) {
      this.pending.set(event.appId, event);
      this.savePendingState();
      log.verbose(`Queued app update for ${event.appId}: ${event.url}`);
      return;
    }
    await this.mountApp(event);
  }

  async applyPendingAppUpdate(appId: string): Promise<boolean> {
    const event = this.pending.get(appId);
    if (!event) return false;
    await this.mountApp(event);
    this.pending.delete(appId);
    this.savePendingState();
    return true;
  }

  listPendingAppUpdates(): AppAvailableEvent[] {
    return [...this.pending.values()];
  }

  private validateElectronApp(event: AppAvailableEvent): void {
    const unsupportedCapabilities = (event.capabilities ?? []).filter(
      (capability) => !electronAppHostCapabilitySet.has(capability)
    );
    if (unsupportedCapabilities.length > 0) {
      throw new Error(
        `Electron app ${event.appId} requests unsupported host capabilities: ${unsupportedCapabilities.join(", ")}`
      );
    }
  }

  private requirePanelView(): PanelViewLike {
    const panelView = this.deps.getPanelView();
    if (!panelView?.createViewForApp) {
      throw new Error("App view runtime is unavailable");
    }
    return panelView;
  }

  private async mountApp(event: AppAvailableEvent): Promise<void> {
    const panelView = this.requirePanelView();
    const createViewForApp = panelView.createViewForApp;
    if (!createViewForApp) throw new Error("App view runtime is unavailable");
    log.verbose(`Loading app view ${event.appId}: ${event.url}`);
    await createViewForApp.call(
      panelView,
      event.appId,
      event.url,
      event.contextId ?? undefined,
      event.capabilities,
      {
        source: event.source,
        effectiveVersion: event.effectiveVersion ?? undefined,
      }
    );
    panelView.setViewVisible?.(event.appId, true);
    this.adopted.set(event.appId, event);
  }

  destroyApp(appId: string): void {
    this.adopted.delete(appId);
    this.pending.delete(appId);
    this.savePendingState();
    this.deps.getPanelView()?.destroyView(appId);
  }

  private pendingStatePath(): string | null {
    return this.deps.statePath
      ? path.join(this.deps.statePath, "app-updates", "pending-electron.json")
      : null;
  }

  private loadPendingState(): void {
    const filePath = this.pendingStatePath();
    if (!filePath || !fs.existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
        pending?: AppAvailableEvent[];
      };
      for (const event of parsed.pending ?? []) {
        if (event?.appId && event.url) this.pending.set(event.appId, event);
      }
    } catch (error) {
      log.warn(
        `Failed to load pending app update state: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private savePendingState(): void {
    const filePath = this.pendingStatePath();
    if (!filePath) return;
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(
        filePath,
        JSON.stringify({ pending: this.listPendingAppUpdates() }, null, 2)
      );
    } catch (error) {
      log.warn(
        `Failed to save pending app update state: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  async loadBakedApp(distDir: string): Promise<boolean> {
    const event = readBakedElectronApp(distDir);
    if (!event) return false;
    await this.applyAppAvailable(event);
    return true;
  }
}

function appAvailableIdentity(event: AppAvailableEvent): string {
  return event.buildKey ?? event.effectiveVersion ?? event.url;
}

export function readBakedElectronApp(distDir: string): AppAvailableEvent | null {
  const manifestPath = path.join(distDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as BakedAppManifest;
  if (manifest.version !== 1) {
    throw new Error(`Unsupported baked app manifest version: ${String(manifest.version)}`);
  }
  if (manifest.app.target !== "electron") return null;
  const html = manifest.artifacts.find((artifact) => artifact.role === "html");
  if (!html) throw new Error(`Baked Electron app ${manifest.app.name} is missing an HTML artifact`);
  const htmlPath = path.join(distDir, "artifacts", html.path);
  if (!fs.existsSync(htmlPath)) {
    throw new Error(`Baked Electron app HTML artifact is missing: ${html.path}`);
  }
  return {
    appId: manifest.app.name,
    source: manifest.app.source,
    target: "electron",
    url: pathToFileURL(htmlPath).href,
    capabilities: manifest.app.capabilities ?? [],
    effectiveVersion: manifest.build.effectiveVersion,
  };
}
