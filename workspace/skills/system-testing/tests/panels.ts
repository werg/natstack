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
    prompt: "Exercise opening a workspace panel. Finish with PANEL_OPEN_OK and handle=<panel-id>.",
    validate: (result) => checkedWithField(result, ["PANEL_OPEN_OK"], "handle"),
  },
  {
    name: "browser-panel",
    description: "Create a browser panel pointing to a URL",
    category: "panels",
    prompt:
      "Exercise opening a browser panel for https://example.com/ with the documented panelTree/openPanel API. Use the returned PanelHandle directly, assert it with assertBrowserPanelHandle from @workspace-skills/system-testing before any CDP call, and never automate panelTree.self(), invented panel IDs, or titles. Do not call adblock APIs. Verify CDP availability with handle.cdp.getCdpEndpoint(). Finish with PANEL_BROWSER_OK and url=<current-url>.",
    validate: (result) => checkedWithField(result, ["PANEL_BROWSER_OK"], "url"),
  },
  {
    name: "browser-navigate",
    description: "Navigate a browser panel to a new URL",
    category: "panels",
    prompt:
      "Exercise browser panel navigation using a browser PanelHandle returned by panelTree/openPanel. Open https://example.com/ first, assert the returned handle with assertBrowserPanelHandle from @workspace-skills/system-testing, then navigate that same child browser handle to https://example.org/ using its CDP/lightweight page APIs. Do not automate panelTree.self(), use data: URLs, about:blank, guessed panel names, read unrelated docs, or call adblock APIs. Finish with PANEL_NAVIGATE_OK and final-marker.",
    validate: (result) => checked(result, ["PANEL_NAVIGATE_OK", "final-marker"]),
  },
  {
    name: "browser-screenshot",
    description: "Take a screenshot of a browser panel",
    category: "panels",
    prompt:
      "Exercise browser panel screenshot capture using a browser PanelHandle returned by panelTree/openPanel for https://example.com/. Assert the returned child handle with assertBrowserPanelHandle from @workspace-skills/system-testing before CDP, initialize the page in the same eval scope before using it, and do not refer to a page variable unless it was assigned by await handle.cdp.lightweightPage(). Do not automate panelTree.self(), use data: URLs, or about:blank. Only report success after a same-run screenshot call returns bytes. Finish with PANEL_SCREENSHOT_OK and bytes=<byte-count>.",
    validate: (result) => checkedWithNumericField(result, ["PANEL_SCREENSHOT_OK"], "bytes"),
  },
  {
    name: "browser-evaluate",
    description: "Evaluate JavaScript in a browser panel",
    category: "panels",
    prompt:
      "Exercise evaluating JavaScript in a browser panel using a browser PanelHandle returned by panelTree/openPanel for https://example.com/. Assert the returned child handle with assertBrowserPanelHandle from @workspace-skills/system-testing, initialize const page = await handle.cdp.lightweightPage() in the same eval before calling page.evaluate(...), and inject or compute marker-match with page.evaluate instead of opening data: URLs or about:blank. Do not automate panelTree.self() or guessed panel IDs/titles. Finish with PANEL_EVALUATE_OK and marker-match.",
    validate: (result) => checked(result, ["PANEL_EVALUATE_OK", "marker-match"]),
  },
  {
    name: "panel-list-sources",
    description: "List visible panel handles through the runtime panel API",
    category: "panels",
    prompt:
      "Exercise listing currently available panels via the runtime panel API. Use @workspace/runtime panelTree/listPanels APIs; do not inspect guessed filesystem roots. Finish with PANEL_SOURCES_OK and count=<number>.",
    validate: (result) => checkedWithNumericField(result, ["PANEL_SOURCES_OK"], "count"),
  },
];
