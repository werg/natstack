import { contextBridge, ipcRenderer } from "electron";

interface OverlayRow {
  label?: unknown;
  meta?: unknown;
  labelRanges?: Array<{ start?: unknown; end?: unknown }>;
  metaRanges?: Array<{ start?: unknown; end?: unknown }>;
  icon?: unknown;
  selected?: unknown;
  type?: unknown;
  payload?: unknown;
}

interface OverlayPayload {
  empty?: unknown;
  rows?: OverlayRow[];
}

contextBridge.exposeInMainWorld("__natstack_shell_overlay", {
  emit: emitOverlay,
  hide: () => ipcRenderer.send("natstack:shell-overlay:hide"),
});

// Rows are pushed from the main process over IPC (the document is loaded once).
ipcRenderer.on("natstack:shell-overlay:render", (_event, payload: OverlayPayload) => {
  renderPayload(payload);
});

function getPanel(): HTMLElement | null {
  return document.getElementById("panel");
}

function renderPayload(payload: OverlayPayload): void {
  const panel = getPanel();
  if (!panel) return;
  panel.replaceChildren();

  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (rows.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = String(payload?.empty ?? "");
    panel.append(empty);
    return;
  }

  rows.forEach((row, index) => {
    const button = document.createElement("button");
    button.className = "row";
    button.dataset["index"] = String(index);
    button.dataset["selected"] = row.selected ? "true" : "false";
    button.type = "button";

    const inner = document.createElement("div");
    inner.className = "row-inner";
    if (typeof row.icon === "string" && row.icon.length > 0) {
      const icon = document.createElement("div");
      icon.className = "icon";
      icon.textContent = iconText(row.icon);
      inner.append(icon);
    }

    const text = document.createElement("div");
    text.className = "text";
    const label = document.createElement("div");
    label.className = "label";
    appendMatchedText(label, String(row.label ?? ""), row.labelRanges);
    text.append(label);

    if (row.meta) {
      const meta = document.createElement("div");
      meta.className = "meta";
      appendMatchedText(meta, String(row.meta), row.metaRanges);
      text.append(meta);
    }

    inner.append(text);
    button.append(inner);
    button.addEventListener("click", () => {
      if (typeof row.type !== "string") return;
      emitOverlay(row.type, row.payload);
    });
    button.addEventListener("keydown", (event) => {
      if (event.key === "Enter") button.click();
      if (event.key === "Tab") {
        event.preventDefault();
        button.click();
      }
      if (event.key === "Escape") emitOverlay("dismiss");
      if (event.key === "ArrowDown") {
        event.preventDefault();
        const target = button.nextElementSibling ?? panel.querySelector(".row");
        if (target instanceof HTMLElement) target.focus();
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        const target = button.previousElementSibling ?? panel.querySelector(".row:last-child");
        if (target instanceof HTMLElement) target.focus();
      }
    });
    panel.append(button);
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") emitOverlay("dismiss");
});

function emitOverlay(type: string, payload?: unknown): void {
  ipcRenderer.send("natstack:shell-overlay:event", { type, payload });
}

function appendMatchedText(
  element: HTMLElement,
  text: string,
  ranges: OverlayRow["labelRanges"]
): void {
  if (!Array.isArray(ranges) || ranges.length === 0) {
    element.textContent = text;
    return;
  }

  let cursor = 0;
  for (const range of normalizeRanges(text, ranges)) {
    if (range.start > cursor) {
      element.append(document.createTextNode(text.slice(cursor, range.start)));
    }
    const match = document.createElement("span");
    match.className = "match";
    match.textContent = text.slice(range.start, range.end);
    element.append(match);
    cursor = range.end;
  }
  if (cursor < text.length) {
    element.append(document.createTextNode(text.slice(cursor)));
  }
}

function normalizeRanges(
  text: string,
  ranges: NonNullable<OverlayRow["labelRanges"]>
): Array<{ start: number; end: number }> {
  const normalized = ranges
    .map((range) => ({
      start: Math.max(0, Math.min(text.length, Number(range.start))),
      end: Math.max(0, Math.min(text.length, Number(range.end))),
    }))
    .filter((range) => range.end > range.start)
    .sort((a, b) => a.start - b.start);

  const result: Array<{ start: number; end: number }> = [];
  let cursor = 0;
  for (const range of normalized) {
    if (range.start < cursor) continue;
    result.push(range);
    cursor = range.end;
  }
  return result;
}

function iconText(kind: string): string {
  return (
    (
      {
        globe: "go",
        history: "h",
        bookmark: "*",
        search: "?",
        session: "s",
        panel: "p",
        branch: "br",
        commit: "c",
      } as Record<string, string>
    )[kind] ?? "-"
  );
}

declare global {
  interface Window {
    __natstack_shell_overlay: {
      emit(type: string, payload?: unknown): void;
      hide(): void;
    };
  }
}
