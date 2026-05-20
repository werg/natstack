import { describe, expect, it } from "vitest";
import type { CommandSuggestion } from "./commandSources.js";
import {
  buildCommandRows,
  COMMAND_ROW_HEIGHT,
  COMMAND_SECTION_HEIGHT,
  offsetForSuggestion,
  visibleCommandRows,
} from "./commandVirtualization.js";

function suggestion(id: string, kind: CommandSuggestion["kind"]): CommandSuggestion {
  if (kind === "builtin") return { id, kind, label: id, action: "newTab" };
  if (kind === "layout") return { id, kind, label: id, layoutId: id };
  return { id, kind, label: id, command: id };
}

describe("command launcher virtualization", () => {
  it("inserts section rows when suggestion groups change", () => {
    const { rows, totalHeight } = buildCommandRows([
      suggestion("recent:a", "recent"),
      suggestion("recent:b", "recent"),
      suggestion("builtin:new", "builtin"),
    ]);

    expect(rows.map((row) => row.type === "section" ? `section:${row.kind}` : row.key)).toEqual([
      "section:recent",
      "recent:a",
      "recent:b",
      "section:builtin",
      "builtin:new",
    ]);
    expect(totalHeight).toBe((2 * COMMAND_SECTION_HEIGHT) + (3 * COMMAND_ROW_HEIGHT));
  });

  it("returns only rows near the visible scroll window", () => {
    const suggestions = Array.from({ length: 100 }, (_, index) => suggestion(`raw:${index}`, "raw"));
    const { rows } = buildCommandRows(suggestions);

    const visible = visibleCommandRows(rows, COMMAND_SECTION_HEIGHT + 50 * COMMAND_ROW_HEIGHT, 5 * COMMAND_ROW_HEIGHT, 1);

    expect(visible.length).toBeLessThan(rows.length);
    expect(visible.some((row) => row.type === "suggestion" && row.index === 50)).toBe(true);
    expect(visible.some((row) => row.type === "suggestion" && row.index === 0)).toBe(false);
  });

  it("finds the absolute offset for keyboard-selected suggestions", () => {
    const { rows } = buildCommandRows([
      suggestion("recent:a", "recent"),
      suggestion("builtin:new", "builtin"),
    ]);

    expect(offsetForSuggestion(rows, 1)).toEqual({
      top: (2 * COMMAND_SECTION_HEIGHT) + COMMAND_ROW_HEIGHT,
      height: COMMAND_ROW_HEIGHT,
    });
  });
});
