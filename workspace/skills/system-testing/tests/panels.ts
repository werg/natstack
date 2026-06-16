import type { TestCase } from "../types.js";
import {
  finalMessageHasAll,
  finalMessageHasField,
  finalMessageHasNumericField,
  noFailedInvocations,
  noIncompleteInvocations,
} from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  const msg = finalMessageHasAll(result, tokens);
  if (!msg.passed) return msg;
  const failed = noFailedInvocations(result);
  if (!failed.passed) return failed;
  return noIncompleteInvocations(result);
}

function checkedWithField(
  result: Parameters<typeof finalMessageHasAll>[0],
  tokens: string[],
  field: string
) {
  const base = checked(result, tokens);
  if (!base.passed) return base;
  return finalMessageHasField(result, field);
}

function checkedWithNumericField(
  result: Parameters<typeof finalMessageHasAll>[0],
  tokens: string[],
  field: string
) {
  const base = checked(result, tokens);
  if (!base.passed) return base;
  return finalMessageHasNumericField(result, field);
}

export const panelTests: TestCase[] = [
  {
    name: "create-panel",
    description: "Open a new panel",
    category: "panels",
    prompt:
      "Exercise opening a spectrolite panel as a child panel using the documented @workspace/runtime panel APIs only. Do not inspect guessed internal source paths. Get a screenshot, retrieve host-captured console logs from the running panel, and run JavaScript in the child panel through handle.cdp.lightweightPage(). Finish with PANEL_OPEN_OK and handle=<panel-id>.",
    validate: (result) => checkedWithField(result, ["PANEL_OPEN_OK"], "handle"),
  },
  {
    name: "browser-panel",
    description: "Create and navigate a browser panel",
    category: "panels",
    prompt:
      "Exercise opening a browser panel for https://example.com/ using openPanel(), then navigate that same browser panel to https://example.org/ with the documented CDP automation API. Reuse the same handle and page; do not open replacement panels or inspect guessed internal source paths. Take a screenshot and run JavaScript in the browser panel. Finish with PANEL_BROWSER_OK, PANEL_NAVIGATE_OK, PANEL_SCREENSHOT_OK, PANEL_EVAL_OK, url=<current-url>, and final-marker.",
    validate: (result) =>
      checkedWithField(result, ["PANEL_BROWSER_OK", "PANEL_NAVIGATE_OK", "PANEL_SCREENSHOT_OK", "PANEL_EVAL_OK", "final-marker"], "url"),
  },
  {
    name: "panel-list-sources",
    description: "List visible panel handles through the runtime panel API",
    category: "panels",
    prompt:
      "Exercise listing currently available panels via the documented runtime panel APIs. Finish with PANEL_SOURCES_OK and count=<number>.",
    validate: (result) => checkedWithNumericField(result, ["PANEL_SOURCES_OK"], "count"),
  },
];
