/**
 * Panel lifecycle suite — in-system port of tests/e2e/flows/panelLifecycle.spec.ts.
 *
 * Strengthened vs. the outside version: instead of smoke-checking whatever the
 * launcher created, it opens a real panel and asserts tree membership, load
 * state, snapshot readability and clean teardown. The "panels persist across
 * app restarts" outside test is intentionally NOT ported — it restarts the
 * host this suite runs in.
 */
import { panelTree } from "@workspace/runtime";
import { suite } from "../run.js";
import { expect } from "../expect.js";
import { openPanel, panelText, waitFor } from "../panels.js";

export const TARGET_PANEL_SOURCE = "panels/spectrolite";

export const panelLifecycle = suite("panel-lifecycle", { timeoutMs: 60_000 })
  .test("panel tree is queryable and entries carry ids and titles", async () => {
    const panels = await panelTree.list();
    expect(panels.length, "panel count").toBeGreaterThanOrEqual(1);
    for (const panel of panels) {
      expect(typeof panel.id, `panel id of ${panel.title}`).toBe("string");
      expect(panel.id.length, "panel id length").toBeGreaterThan(0);
      expect(typeof panel.title, `panel title of ${panel.id}`).toBe("string");
    }
  })
  .test("opening a panel adds it to the tree as a child", async (t) => {
    const handle = await openPanel(TARGET_PANEL_SOURCE);
    t.defer(() => handle.close().then(() => undefined));
    const panels = await panelTree.list();
    expect(
      panels.some((panel) => panel.id === handle.id),
      "opened panel present in tree"
    ).toBeTruthy();
  })
  .test("opened panel reports loaded and yields a readable snapshot", async (t) => {
    const handle = await openPanel(TARGET_PANEL_SOURCE);
    t.defer(() => handle.close().then(() => undefined));
    expect(await handle.isLoaded(), "isLoaded").toBe(true);
    const text = await waitFor(async () => (await panelText(handle)) || undefined, {
      label: "panel renders visible text",
    });
    expect(text.length, "snapshot text length").toBeGreaterThan(0);
  })
  .test("closing a panel removes it from the tree", async () => {
    const handle = await openPanel(TARGET_PANEL_SOURCE);
    await handle.close();
    await waitFor(
      async () => {
        const panels = await panelTree.list();
        return panels.every((panel) => panel.id !== handle.id) || undefined;
      },
      { label: "panel removed from tree" }
    );
  })
  .test("self handle is available and reports a workspace panel", async () => {
    const self = panelTree.self();
    expect(typeof self.id, "self id").toBe("string");
    expect(self.kind, "self kind").toBe("workspace");
  });
