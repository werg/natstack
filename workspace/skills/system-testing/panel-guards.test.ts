import { describe, expect, it, vi } from "vitest";
import type { PanelHandle } from "@workspace/runtime";
import { assertBrowserPanelHandle, refreshBrowserPanelHandle } from "./panel-guards.js";

function handle(kind: "workspace" | "browser"): PanelHandle {
  return {
    id: `${kind}-1`,
    kind,
    refresh: vi.fn(async function (this: PanelHandle) {
      return this;
    }),
  } as unknown as PanelHandle;
}

describe("panel-guards", () => {
  it("accepts browser handles", () => {
    const browser = handle("browser");
    expect(assertBrowserPanelHandle(browser)).toBe(browser);
  });

  it("rejects workspace handles with CDP-specific guidance", () => {
    expect(() => assertBrowserPanelHandle(handle("workspace"), "target")).toThrow(
      "Do not drive panelTree.self() through CDP"
    );
  });

  it("refreshes stale handles before checking their kind", async () => {
    const browser = handle("browser");
    await expect(refreshBrowserPanelHandle(browser)).resolves.toBe(browser);
    expect(browser.refresh).toHaveBeenCalled();
  });
});
