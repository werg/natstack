import { describe, expect, it } from "vitest";
import type { Panel } from "@natstack/shared/types";
import { coercePanelTreeUpdate } from "./panelTreeRevision";

function panel(id: string): Panel {
  return {
    id,
    title: id,
    children: [],
    snapshot: {
      source: `panels/${id}`,
      contextId: `ctx-${id}`,
      options: {},
    },
    artifacts: {},
  };
}

describe("coercePanelTreeUpdate", () => {
  it("accepts newer revisioned snapshots", () => {
    const root = panel("root");

    expect(
      coercePanelTreeUpdate(
        {
          revision: 3,
          rootPanels: [root],
        },
        2
      )
    ).toEqual({
      revision: 3,
      rootPanels: [root],
    });
  });

  it("rejects stale revisioned snapshots", () => {
    expect(
      coercePanelTreeUpdate(
        {
          revision: 2,
          rootPanels: [panel("old")],
        },
        3
      )
    ).toBeNull();
  });

  it("allows legacy array events only before a revisioned update is known", () => {
    const root = panel("legacy");

    expect(coercePanelTreeUpdate([root], 0)).toEqual({
      revision: 0,
      rootPanels: [root],
    });
    expect(coercePanelTreeUpdate([root], 1)).toBeNull();
  });
});
