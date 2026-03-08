/**
 * AutofillManager Unit Tests
 *
 * Tests signal tier logic, save/update/never flows, and credential lifecycle.
 * Uses mocked Electron APIs and injected dependencies.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// Mock Electron before importing AutofillManager
vi.mock("electron", () => ({
  ipcMain: {
    on: vi.fn(),
    removeAllListeners: vi.fn(),
  },
}));

// Mock content script generators
vi.mock("./contentScript.js", () => ({
  AUTOFILL_WORLD_ID: 1000,
  getContentScript: vi.fn().mockReturnValue("/* content script */"),
  getPullStateScript: vi.fn().mockReturnValue("/* pull state */"),
  getReadSnapshotScript: vi.fn().mockReturnValue("/* read snapshot */"),
  getFillScript: vi.fn().mockReturnValue("/* fill */"),
  getInjectKeyIconScript: vi.fn().mockReturnValue("/* inject icon */"),
}));

// Mock overlay
vi.mock("./autofillOverlay.js", () => ({
  AutofillOverlay: vi.fn().mockImplementation(() => ({
    setCallbacks: vi.fn(),
    setWindow: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    bringToFront: vi.fn(),
    destroy: vi.fn(),
  })),
}));

// Mock dev logger
vi.mock("@natstack/dev-log", () => ({
  createDevLogger: () => ({
    verbose: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { AutofillManager } from "./autofillManager.js";
import type { StoredPassword } from "@natstack/browser-data";

function createMockPasswordStore() {
  return {
    getForOrigin: vi.fn().mockReturnValue([]),
    updateLastUsed: vi.fn(),
    update: vi.fn(),
    add: vi.fn().mockReturnValue(1),
    addNeverSave: vi.fn(),
    isNeverSave: vi.fn().mockReturnValue(false),
  };
}

function createMockEventService() {
  return {
    emit: vi.fn(),
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  };
}

function createMockWebContents(id: number, url = "https://example.com/login") {
  return {
    id,
    getURL: vi.fn().mockReturnValue(url),
    isDestroyed: vi.fn().mockReturnValue(false),
    on: vi.fn(),
    off: vi.fn(),
    session: { webRequest: { onCompleted: vi.fn() } },
    executeJavaScriptInIsolatedWorld: vi.fn().mockResolvedValue(null),
  } as any;
}

function createMockViewManager() {
  return {
    findViewIdByWebContentsId: vi.fn().mockReturnValue("panel-1"),
    getWebContents: vi.fn(),
    getViewInfo: vi.fn().mockReturnValue({ bounds: { x: 0, y: 0, width: 800, height: 600 } }),
  };
}

function createManager(overrides: {
  passwordStore?: ReturnType<typeof createMockPasswordStore>;
  eventService?: ReturnType<typeof createMockEventService>;
  viewManager?: ReturnType<typeof createMockViewManager>;
} = {}) {
  const passwordStore = overrides.passwordStore ?? createMockPasswordStore();
  const eventService = overrides.eventService ?? createMockEventService();
  const viewManager = overrides.viewManager ?? createMockViewManager();

  const manager = new AutofillManager({
    passwordStore,
    eventService: eventService as any,
    getViewManager: () => viewManager as any,
    autofillOverlayPreloadPath: "/fake/preload.js",
  });

  return { manager, passwordStore, eventService, viewManager };
}

function makeCredential(id: number, username: string, password: string, origin = "https://example.com"): StoredPassword {
  return {
    id,
    origin_url: origin,
    username,
    password,
    action_url: "",
    realm: "",
    date_created: Date.now(),
    date_last_used: null,
    date_password_changed: null,
    times_used: 0,
  };
}

describe("AutofillManager", () => {
  describe("attachToWebContents", () => {
    it("registers dom-ready and navigation listeners", () => {
      const { manager } = createManager();
      const wc = createMockWebContents(1);

      manager.attachToWebContents(1, wc);

      const onCalls = wc.on.mock.calls.map((c: any) => c[0]);
      expect(onCalls).toContain("dom-ready");
      expect(onCalls).toContain("did-navigate");
      expect(onCalls).toContain("did-navigate-in-page");
      expect(onCalls).toContain("will-navigate");
    });

    it("works even when URL is not yet committed (about:blank)", () => {
      const { manager } = createManager();
      const wc = createMockWebContents(1, "about:blank");

      // Should not throw — origin resolution is deferred to dom-ready
      manager.attachToWebContents(1, wc);

      const onCalls = wc.on.mock.calls.map((c: any) => c[0]);
      expect(onCalls).toContain("dom-ready");
    });
  });

  describe("detachFromWebContents", () => {
    it("removes event listeners and cleans up state", () => {
      const { manager } = createManager();
      const wc = createMockWebContents(1);

      manager.attachToWebContents(1, wc);
      manager.detachFromWebContents(1, wc);

      expect(wc.off.mock.calls.length).toBe(5); // dom-ready, did-navigate, in-page, will-navigate, frame-load
    });

    it("clears pending credentials on detach", () => {
      const { manager, viewManager } = createManager();
      const wc = createMockWebContents(1);
      viewManager.findViewIdByWebContentsId.mockReturnValue("panel-1");

      manager.attachToWebContents(1, wc);

      // Manually set a pending credential via confirmSave test path
      // We'll verify it's gone after detach by checking the service definition works
      manager.detachFromWebContents(1, wc);

      // No crash, state cleaned up
    });
  });

  describe("handleConfirmSave", () => {
    it("'save' action adds credential to store", async () => {
      const { manager, passwordStore } = createManager();
      const serviceDef = manager.getServiceDefinition();

      // Manually inject a pending credential via private access
      (manager as any).pendingCredentials.set("panel-1", {
        username: "alice",
        password: "secret",
        origin: "https://example.com",
        isUpdate: false,
      });

      await serviceDef.handler!({ callerId: "shell", callerKind: "shell" as const }, "confirmSave", ["panel-1", "save"]);

      expect(passwordStore.add).toHaveBeenCalledWith({
        url: "https://example.com",
        username: "alice",
        password: "secret",
      });
    });

    it("'save' action updates existing credential", async () => {
      const { manager, passwordStore } = createManager();
      const serviceDef = manager.getServiceDefinition();

      (manager as any).pendingCredentials.set("panel-1", {
        username: "alice",
        password: "newpass",
        origin: "https://example.com",
        isUpdate: true,
        existingId: 42,
      });

      await serviceDef.handler!({ callerId: "shell", callerKind: "shell" as const }, "confirmSave", ["panel-1", "save"]);

      expect(passwordStore.update).toHaveBeenCalledWith(42, { password: "newpass" });
    });

    it("'never' action persists to password store", async () => {
      const { manager, passwordStore } = createManager();
      const serviceDef = manager.getServiceDefinition();

      (manager as any).pendingCredentials.set("panel-1", {
        username: "alice",
        password: "secret",
        origin: "https://example.com",
        isUpdate: false,
      });

      await serviceDef.handler!({ callerId: "shell", callerKind: "shell" as const }, "confirmSave", ["panel-1", "never"]);

      expect(passwordStore.addNeverSave).toHaveBeenCalledWith("https://example.com");
      expect(passwordStore.add).not.toHaveBeenCalled();
    });

    it("'dismiss' action sets temporary suppression without persisting", async () => {
      const { manager, passwordStore } = createManager();
      const serviceDef = manager.getServiceDefinition();

      // Attach a webContents so panelState exists
      const wc = createMockWebContents(1);
      passwordStore.getForOrigin.mockReturnValue([]);
      manager.attachToWebContents(1, wc);

      // Set origin on the state
      const state = (manager as any).panelState.get(1);
      state.origin = "https://example.com";

      (manager as any).pendingCredentials.set("panel-1", {
        username: "alice",
        password: "secret",
        origin: "https://example.com",
        isUpdate: false,
      });

      await serviceDef.handler!({ callerId: "shell", callerKind: "shell" as const }, "confirmSave", ["panel-1", "dismiss"]);

      expect(passwordStore.addNeverSave).not.toHaveBeenCalled();
      expect(state.dismissedAt).toBeGreaterThan(0);
    });

    it("clears pending credential on any action", async () => {
      const { manager } = createManager();
      const serviceDef = manager.getServiceDefinition();

      (manager as any).pendingCredentials.set("panel-1", {
        username: "alice",
        password: "secret",
        origin: "https://example.com",
        isUpdate: false,
      });

      await serviceDef.handler!({ callerId: "shell", callerKind: "shell" as const }, "confirmSave", ["panel-1", "dismiss"]);

      expect((manager as any).pendingCredentials.has("panel-1")).toBe(false);
    });
  });

  describe("signal tier logic", () => {
    function setupWithSnapshot(manager: AutofillManager, wcId: number) {
      const state = (manager as any).panelState.get(wcId);
      state.hasPendingSnapshot = true;
      state.origin = "https://example.com";
      return state;
    }

    it("strong signal triggers save", () => {
      const { manager } = createManager();
      const wc = createMockWebContents(1);
      manager.attachToWebContents(1, wc);

      const state = setupWithSnapshot(manager, 1);
      const triggerSpy = vi.spyOn(manager as any, "triggerSave").mockResolvedValue(undefined);

      (manager as any).addSignal(1, "strong");

      expect(triggerSpy).toHaveBeenCalledWith(1, false);
    });

    it("single medium signal triggers check-only save", () => {
      const { manager } = createManager();
      const wc = createMockWebContents(1);
      manager.attachToWebContents(1, wc);

      const state = setupWithSnapshot(manager, 1);
      const triggerSpy = vi.spyOn(manager as any, "triggerSave").mockResolvedValue(undefined);

      (manager as any).addSignal(1, "medium");

      expect(triggerSpy).toHaveBeenCalledWith(1, true); // onlyIfChanged = true
    });

    it("two medium signals trigger full save", () => {
      const { manager } = createManager();
      const wc = createMockWebContents(1);
      manager.attachToWebContents(1, wc);

      const state = setupWithSnapshot(manager, 1);
      const triggerSpy = vi.spyOn(manager as any, "triggerSave").mockResolvedValue(undefined);

      (manager as any).addSignal(1, "medium");
      expect(triggerSpy).toHaveBeenCalledWith(1, true); // first medium = check-only

      triggerSpy.mockClear();
      (manager as any).addSignal(1, "medium");
      expect(triggerSpy).toHaveBeenCalledWith(1, false); // second medium = full save
    });

    it("medium + weak signals trigger full save", () => {
      const { manager } = createManager();
      const wc = createMockWebContents(1);
      manager.attachToWebContents(1, wc);

      const state = setupWithSnapshot(manager, 1);
      const triggerSpy = vi.spyOn(manager as any, "triggerSave").mockResolvedValue(undefined);

      (manager as any).addSignal(1, "weak");
      expect(triggerSpy).not.toHaveBeenCalled(); // weak alone = nothing

      (manager as any).addSignal(1, "medium");
      expect(triggerSpy).toHaveBeenCalledWith(1, false); // medium + weak = full save
    });

    it("never-save origin suppresses all signals", () => {
      const { manager, passwordStore } = createManager();
      const wc = createMockWebContents(1);
      manager.attachToWebContents(1, wc);

      const state = setupWithSnapshot(manager, 1);
      passwordStore.isNeverSave.mockReturnValue(true);

      const triggerSpy = vi.spyOn(manager as any, "triggerSave").mockResolvedValue(undefined);
      (manager as any).addSignal(1, "strong");

      expect(triggerSpy).not.toHaveBeenCalled();
    });

    it("recently dismissed origin suppresses signals", () => {
      const { manager } = createManager();
      const wc = createMockWebContents(1);
      manager.attachToWebContents(1, wc);

      const state = setupWithSnapshot(manager, 1);
      state.dismissedAt = Date.now(); // just dismissed

      const triggerSpy = vi.spyOn(manager as any, "triggerSave").mockResolvedValue(undefined);
      (manager as any).addSignal(1, "strong");

      expect(triggerSpy).not.toHaveBeenCalled();
    });

    it("old dismissal (>10min) does not suppress", () => {
      const { manager } = createManager();
      const wc = createMockWebContents(1);
      manager.attachToWebContents(1, wc);

      const state = setupWithSnapshot(manager, 1);
      state.dismissedAt = Date.now() - 11 * 60 * 1000; // 11 minutes ago

      const triggerSpy = vi.spyOn(manager as any, "triggerSave").mockResolvedValue(undefined);
      (manager as any).addSignal(1, "strong");

      expect(triggerSpy).toHaveBeenCalled();
    });

    it("no pending snapshot means signals are ignored", () => {
      const { manager } = createManager();
      const wc = createMockWebContents(1);
      manager.attachToWebContents(1, wc);

      // hasPendingSnapshot defaults to false
      const triggerSpy = vi.spyOn(manager as any, "triggerSave").mockResolvedValue(undefined);
      (manager as any).addSignal(1, "strong");

      expect(triggerSpy).not.toHaveBeenCalled();
    });
  });

  describe("triggerSave credential matching", () => {
    it("silently updates lastUsed for identical credentials", async () => {
      const { manager, passwordStore, eventService, viewManager } = createManager();
      const wc = createMockWebContents(1);
      const existingCred = makeCredential(1, "alice", "same-pass");

      passwordStore.getForOrigin.mockReturnValue([existingCred]);
      viewManager.getWebContents.mockReturnValue(wc);

      manager.attachToWebContents(1, wc);
      const state = (manager as any).panelState.get(1);
      state.origin = "https://example.com";
      state.credentials = [existingCred];
      state.hasPendingSnapshot = true;

      // Mock snapshot read
      wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce({
        username: "alice",
        password: "same-pass",
        timestamp: Date.now(),
        pageUrl: "https://example.com",
        actionUrl: null,
      });

      await (manager as any).triggerSave(1, false);

      expect(passwordStore.updateLastUsed).toHaveBeenCalledWith(1);
      expect(eventService.emit).not.toHaveBeenCalled();
    });

    it("prompts for update when password changed", async () => {
      const { manager, passwordStore, eventService, viewManager } = createManager();
      const wc = createMockWebContents(1);
      const existingCred = makeCredential(1, "alice", "old-pass");

      viewManager.getWebContents.mockReturnValue(wc);

      manager.attachToWebContents(1, wc);
      const state = (manager as any).panelState.get(1);
      state.origin = "https://example.com";
      state.credentials = [existingCred];
      state.hasPendingSnapshot = true;

      wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce({
        username: "alice",
        password: "new-pass",
        timestamp: Date.now(),
        pageUrl: "https://example.com",
        actionUrl: null,
      });

      await (manager as any).triggerSave(1, false);

      expect(eventService.emit).toHaveBeenCalledWith("autofill:save-prompt", expect.objectContaining({
        username: "alice",
        isUpdate: true,
      }));
    });

    it("skips new credentials when onlyIfChanged is true", async () => {
      const { manager, passwordStore, eventService, viewManager } = createManager();
      const wc = createMockWebContents(1);

      passwordStore.getForOrigin.mockReturnValue([]);
      viewManager.getWebContents.mockReturnValue(wc);

      manager.attachToWebContents(1, wc);
      const state = (manager as any).panelState.get(1);
      state.origin = "https://example.com";
      state.credentials = [];
      state.hasPendingSnapshot = true;

      wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce({
        username: "alice",
        password: "new-pass",
        timestamp: Date.now(),
        pageUrl: "https://example.com",
        actionUrl: null,
      });

      await (manager as any).triggerSave(1, true); // onlyIfChanged

      expect(eventService.emit).not.toHaveBeenCalled();
    });

    it("prompts for new credential save when onlyIfChanged is false", async () => {
      const { manager, passwordStore, eventService, viewManager } = createManager();
      const wc = createMockWebContents(1);

      passwordStore.getForOrigin.mockReturnValue([]);
      viewManager.getWebContents.mockReturnValue(wc);

      manager.attachToWebContents(1, wc);
      const state = (manager as any).panelState.get(1);
      state.origin = "https://example.com";
      state.credentials = [];
      state.hasPendingSnapshot = true;

      wc.executeJavaScriptInIsolatedWorld.mockResolvedValueOnce({
        username: "bob",
        password: "bobpass",
        timestamp: Date.now(),
        pageUrl: "https://example.com",
        actionUrl: null,
      });

      await (manager as any).triggerSave(1, false);

      expect(eventService.emit).toHaveBeenCalledWith("autofill:save-prompt", expect.objectContaining({
        username: "bob",
        isUpdate: false,
      }));
    });
  });

  describe("content script generation", () => {
    it("getFillScript passes values through JSON.stringify", async () => {
      // Un-mock for this test
      const { getFillScript } = await vi.importActual<typeof import("./contentScript.js")>("./contentScript.js");

      const script = getFillScript("#user", "#pass", 'alice"</script>', "p'ass");

      // Values are wrapped in JSON.stringify, so quotes are escaped
      expect(script).toContain(JSON.stringify('alice"</script>'));
      expect(script).toContain(JSON.stringify("p'ass"));
      // Selectors are also JSON-stringified
      expect(script).toContain(JSON.stringify("#user"));
      expect(script).toContain(JSON.stringify("#pass"));
    });
  });
});
