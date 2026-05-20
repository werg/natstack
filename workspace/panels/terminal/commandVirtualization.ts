import type { CommandSuggestion } from "./commandSources.js";

export type CommandDisplayRow =
  | { type: "section"; key: string; kind: CommandSuggestion["kind"]; top: number; height: number }
  | { type: "suggestion"; key: string; suggestion: CommandSuggestion; index: number; top: number; height: number };

export const COMMAND_ROW_HEIGHT = 40;
export const COMMAND_SECTION_HEIGHT = 28;

export function buildCommandRows(suggestions: CommandSuggestion[]): { rows: CommandDisplayRow[]; totalHeight: number } {
  const rows: CommandDisplayRow[] = [];
  let top = 0;
  let lastKind: CommandSuggestion["kind"] | undefined;

  suggestions.forEach((suggestion, index) => {
    if (suggestion.kind !== lastKind) {
      rows.push({ type: "section", key: `section:${suggestion.kind}:${index}`, kind: suggestion.kind, top, height: COMMAND_SECTION_HEIGHT });
      top += COMMAND_SECTION_HEIGHT;
      lastKind = suggestion.kind;
    }
    rows.push({ type: "suggestion", key: suggestion.id, suggestion, index, top, height: COMMAND_ROW_HEIGHT });
    top += COMMAND_ROW_HEIGHT;
  });

  return { rows, totalHeight: top };
}

export function visibleCommandRows(rows: CommandDisplayRow[], scrollTop: number, viewportHeight: number, overscan = 4): CommandDisplayRow[] {
  const start = Math.max(0, scrollTop - overscan * COMMAND_ROW_HEIGHT);
  const end = scrollTop + viewportHeight + overscan * COMMAND_ROW_HEIGHT;
  return rows.filter((row) => row.top + row.height >= start && row.top <= end);
}

export function offsetForSuggestion(rows: CommandDisplayRow[], index: number): { top: number; height: number } | undefined {
  const row = rows.find((item) => item.type === "suggestion" && item.index === index);
  return row ? { top: row.top, height: row.height } : undefined;
}
