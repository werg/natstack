import { describe, expect, it } from "vitest";
import {
  defaultTerminalState,
  migrateState,
  SCRATCH_BUFFER_MAX_COUNT,
  SCRATCH_BUFFER_MAX_TEXT_BYTES,
  TERMINAL_STATE_SCHEMA_VERSION,
} from "./migrateState.js";

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

  it("defaults malformed booleans", () => {
    const migrated = migrateState({
      notificationCenterOpen: "true",
      imagePasteRelative: "yes",
    });

    expect(migrated.notificationCenterOpen).toBe(false);
    expect(migrated.imagePasteRelative).toBe(false);
  });

  it("sanitizes the current split tree and focused session", () => {
    const migrated = migrateState({
      focusedSessionId: "missing",
      tree: {
        kind: "split",
        direction: "diagonal",
        ratio: 99,
        a: { kind: "leaf", sessionId: "s1", stale: true },
        b: { kind: "leaf", sessionId: "" },
      },
    });

    expect(migrated.tree).toEqual({ kind: "leaf", sessionId: "s1" });
    expect(migrated.focusedSessionId).toBe("s1");
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

  it("normalizes minimal notifications", () => {
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
      keybindings: { palette: "Ctrl+K", newPane: "Mod+T" },
    });

    expect(migrated.keybindings).toEqual({});
  });

  it("supplies empty scratch state when missing from v1 persisted state", () => {
    const migrated = migrateState({ fontSize: 13 });

    expect(migrated.scratchBuffers).toEqual([]);
    expect(migrated.scratchActiveBufferId).toBeUndefined();
    expect(migrated.scratchOpen).toBe(false);
  });

  it("preserves valid scratch buffers and drops invalid entries", () => {
    const migrated = migrateState({
      scratchBuffers: [
        { bufferId: "b1", text: "echo hi", createdAt: 100, updatedAt: 200 },
        { bufferId: "", text: "skip" },
        { bufferId: "b2", text: 42 },
        null,
        { bufferId: "b3", text: "", createdAt: 1, updatedAt: 2 },
      ],
    });

    expect(migrated.scratchBuffers).toEqual([
      { bufferId: "b1", text: "echo hi", createdAt: 100, updatedAt: 200 },
      { bufferId: "b3", text: "", createdAt: 1, updatedAt: 2 },
    ]);
  });

  it("clamps scratch buffer text length and stack depth", () => {
    const longText = "x".repeat(SCRATCH_BUFFER_MAX_TEXT_BYTES + 500);
    const oversized = Array.from({ length: SCRATCH_BUFFER_MAX_COUNT + 5 }, (_, index) => ({
      bufferId: `b${index}`,
      text: index === 0 ? longText : `t${index}`,
      createdAt: index,
      updatedAt: index,
    }));
    const migrated = migrateState({ scratchBuffers: oversized });

    expect(migrated.scratchBuffers).toHaveLength(SCRATCH_BUFFER_MAX_COUNT);
    expect(migrated.scratchBuffers[0]?.text.length).toBe(SCRATCH_BUFFER_MAX_TEXT_BYTES);
  });

  it("keeps scratchActiveBufferId only if it still exists after sanitisation", () => {
    const validated = migrateState({
      scratchBuffers: [{ bufferId: "keep", text: "x", createdAt: 1, updatedAt: 1 }],
      scratchActiveBufferId: "keep",
    });
    expect(validated.scratchActiveBufferId).toBe("keep");

    const dropped = migrateState({
      scratchBuffers: [{ bufferId: "keep", text: "x", createdAt: 1, updatedAt: 1 }],
      scratchActiveBufferId: "ghost",
    });
    expect(dropped.scratchActiveBufferId).toBeUndefined();
  });

  it("always forces scratchOpen to false on reload", () => {
    const migrated = migrateState({ scratchOpen: true });
    expect(migrated.scratchOpen).toBe(false);
  });

  it("drops unknown persisted fields instead of carrying them forward", () => {
    const migrated = migrateState({
      tree: undefined,
      unexpected: "stale",
      nested: { value: true },
    }) as unknown as Record<string, unknown>;

    expect(migrated["unexpected"]).toBeUndefined();
    expect(migrated["nested"]).toBeUndefined();
  });
});
