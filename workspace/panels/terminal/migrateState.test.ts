import { describe, expect, it } from "vitest";
import { defaultTerminalState, migrateState, TERMINAL_STATE_SCHEMA_VERSION } from "./migrateState.js";

describe("terminal state migration", () => {
  it("fills defaults for missing or invalid persisted state", () => {
    expect(migrateState(null)).toEqual(defaultTerminalState());
    expect(migrateState({ fontSize: Number.NaN, themeOverride: "sepia", pasteMode: "html" })).toMatchObject({
      fontSize: 13,
      themeOverride: "auto",
      pasteMode: "path",
      schemaVersion: TERMINAL_STATE_SCHEMA_VERSION,
    });
  });

  it("clamps numeric settings and caps palette history", () => {
    const migrated = migrateState({
      fontSize: 100,
      scrollbackBytes: 99 * 1024 * 1024,
      paletteHistory: Array.from({ length: 25 }, (_, index) => index % 2 ? `cmd-${index}` : index),
    });

    expect(migrated.fontSize).toBe(24);
    expect(migrated.scrollbackBytes).toBe(8 * 1024 * 1024);
    expect(migrated.paletteHistory).toHaveLength(12);
    expect(migrated.paletteHistory.every((item) => typeof item === "string")).toBe(true);
  });

  it("defaults malformed booleans and caps saved layouts", () => {
    const migrated = migrateState({
      notificationCenterOpen: "true",
      sidebarCollapsed: 1,
      imagePasteRelative: "yes",
      savedLayouts: Array.from({ length: 40 }, (_, index) => ({
        id: `layout-${index}`,
        name: `Layout ${index}`,
        tree: { kind: "leaf", sessionId: "s1" },
        cwds: {},
        labels: {},
        updatedAt: index,
      })),
    });

    expect(migrated.notificationCenterOpen).toBe(false);
    expect(migrated.sidebarCollapsed).toBe(false);
    expect(migrated.imagePasteRelative).toBe(false);
    expect(migrated.savedLayouts).toHaveLength(32);
    expect(migrated.savedLayouts[0]?.id).toBe("layout-39");
    expect(migrated.savedLayouts[migrated.savedLayouts.length - 1]?.id).toBe("layout-8");
  });

  it("drops malformed tabs and sanitizes nested tab fields", () => {
    const migrated = migrateState({
      tabs: [
        { tabId: "bad", label: "Bad", tree: { kind: "leaf", sessionId: "" }, focusedSessionId: "" },
        {
          tabId: "good",
          label: "",
          tree: {
            kind: "split",
            direction: "diagonal",
            ratio: 99,
            a: { kind: "leaf", sessionId: "s1", stale: true },
            b: { kind: "leaf", sessionId: "" },
          },
          badge: { text: "3", severity: "approval", extra: "drop" },
          unknown: "drop",
        },
      ],
    });

    expect(migrated.tabs).toEqual([{
      tabId: "good",
      label: "Terminal",
      tree: { kind: "leaf", sessionId: "s1" },
      focusedSessionId: "s1",
      badge: { text: "3", severity: "approval" },
    }]);
  });

  it("sanitizes per-session restore state", () => {
    const migrated = migrateState({
      perSession: {
        s1: { label: "App", cwd: "/repo", originalArgv: ["pnpm", 1, "dev"], readCursor: -1, lastSeenAt: Number.POSITIVE_INFINITY, extra: true },
        s2: null,
        s3: { cwd: "", readCursor: 12, lastSeenAt: 13 },
      },
    });

    expect(migrated.perSession).toEqual({
      s1: { label: "App", cwd: "/repo", originalArgv: ["pnpm", "dev"], readCursor: 0, lastSeenAt: 0 },
      s3: { cwd: ".", readCursor: 12, lastSeenAt: 13 },
    });
  });

  it("drops malformed saved layouts and sanitizes valid layouts", () => {
    const migrated = migrateState({
      savedLayouts: [
        { id: "bad", name: "Bad", tree: { kind: "split", a: null, b: null }, cwds: {}, labels: {}, updatedAt: 10 },
        {
          id: "good",
          name: "",
          tree: {
            kind: "split",
            direction: "column",
            ratio: 0.9,
            a: { kind: "leaf", sessionId: "slot-1" },
            b: { kind: "leaf", sessionId: "slot-2" },
          },
          cwds: { "slot-1": "/repo", "slot-2": 42 },
          labels: { "slot-1": "Shell", "slot-2": null },
          icon: "T",
          accent: "blue",
          updatedAt: 1,
          extra: "drop",
        },
      ],
    });

    expect(migrated.savedLayouts).toEqual([{
      id: "good",
      name: "Saved layout",
      tree: {
        kind: "split",
        direction: "column",
        ratio: 0.85,
        a: { kind: "leaf", sessionId: "slot-1" },
        b: { kind: "leaf", sessionId: "slot-2" },
      },
      cwds: { "slot-1": "/repo" },
      labels: { "slot-1": "Shell" },
      icon: "T",
      accent: "blue",
      updatedAt: 1,
    }]);
  });

  it("normalizes legacy notifications", () => {
    const migrated = migrateState({
      notifications: [{
        sessionId: "s1",
        message: "build done",
      }],
    });

    expect(migrated.notifications[0]).toMatchObject({
      sessionId: "s1",
      severity: "info",
      message: "build done",
      read: false,
    });
    expect(migrated.notifications[0]?.notifId).toEqual(expect.any(String));
    expect(migrated.notifications[0]?.timestamp).toEqual(expect.any(Number));
  });

  it("sanitizes malformed notification fields", () => {
    const migrated = migrateState({
      notifications: [{
        notifId: "",
        sessionId: 123,
        severity: "urgent",
        title: 42,
        message: 99,
        timestamp: Number.POSITIVE_INFINITY,
        read: "yes",
        source: "external",
      }],
    });

    expect(migrated.notifications[0]).toMatchObject({
      sessionId: "",
      severity: "info",
      message: "",
      read: false,
    });
    expect(migrated.notifications[0]?.notifId).toEqual(expect.any(String));
    expect(migrated.notifications[0]?.title).toBeUndefined();
    expect(migrated.notifications[0]?.source).toBeUndefined();
    expect(migrated.notifications[0]?.timestamp).toEqual(expect.any(Number));
  });

  it("sanitizes unsafe keybinding overrides", () => {
    const migrated = migrateState({
      keybindings: { palette: "Ctrl+K", newTab: "Mod+T" },
    });

    expect(migrated.keybindings).toEqual({});
  });

  it("drops unknown persisted fields instead of carrying them forward", () => {
    const migrated = migrateState({
      tabs: [],
      unexpected: "stale",
      nested: { value: true },
    }) as unknown as Record<string, unknown>;

    expect(migrated["unexpected"]).toBeUndefined();
    expect(migrated["nested"]).toBeUndefined();
  });
});
