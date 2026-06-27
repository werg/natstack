import { describe, expect, it } from "vitest";
import { CONFIG_LOADER_JS } from "./configLoader.js";

describe("CONFIG_LOADER_JS", () => {
  it("requires canonical entityId bootstrap identity without the old panelId alias", () => {
    expect(CONFIG_LOADER_JS).toContain("const entityId = cfg?.entityId;");
    expect(CONFIG_LOADER_JS).not.toContain("cfg?.panelId");
  });

  it("publishes runtime lease fields before loading the WebSocket transport", () => {
    expect(CONFIG_LOADER_JS.indexOf("__natstackConnectionId")).toBeGreaterThan(-1);
    expect(CONFIG_LOADER_JS.indexOf('new URL("__transport.js"')).toBeGreaterThan(-1);
    expect(CONFIG_LOADER_JS.indexOf("__natstackConnectionId")).toBeLessThan(
      CONFIG_LOADER_JS.indexOf('new URL("__transport.js"')
    );
  });

  it("keeps runtime lease ids out of persisted/userland bootstrap state", () => {
    expect(CONFIG_LOADER_JS).not.toContain('url.searchParams.get("connectionId")');
    expect(CONFIG_LOADER_JS).toContain('typeof cfg?.connectionId === "string"');
    expect(CONFIG_LOADER_JS).toContain("delete stored.connectionId");
    expect(CONFIG_LOADER_JS).toContain("delete globalThis.__natstackConnectionId");
  });

  it("keys persisted panel init by document URL instead of one shared session key", () => {
    expect(CONFIG_LOADER_JS).toContain(
      'const storageKey = () => "__natstackPanelInit:" + location.href;'
    );
    expect(CONFIG_LOADER_JS).toContain("sessionStorage.getItem(storageKey())");
    expect(CONFIG_LOADER_JS).toContain("sessionStorage.setItem(storageKey()");
    expect(CONFIG_LOADER_JS).not.toContain('sessionStorage.getItem("__natstackPanelInit")');
    expect(CONFIG_LOADER_JS).not.toContain('sessionStorage.setItem("__natstackPanelInit"');
  });
});
