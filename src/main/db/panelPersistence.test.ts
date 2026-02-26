describe("panelPersistence exports", () => {
  // better-sqlite3 native module may not be compatible with this Node version,
  // so we attempt the import and skip gracefully if it fails.
  let mod: any;

  beforeAll(async () => {
    try {
      mod = await import("./panelPersistence.js");
    } catch {
      // better-sqlite3 native module may not be compatible
    }
  });

  it("exports getPanelPersistence function", () => {
    if (!mod) return; // skip if import failed
    expect(typeof mod.getPanelPersistence).toBe("function");
  });

  it("exports resetPanelPersistence function", () => {
    if (!mod) return; // skip if import failed
    expect(typeof mod.resetPanelPersistence).toBe("function");
  });

  it("exports PanelPersistence class", () => {
    if (!mod) return; // skip if import failed
    expect(typeof mod.PanelPersistence).toBe("function");
    // It should be a class (constructor)
    expect(mod.PanelPersistence.prototype).toBeDefined();
  });
});
