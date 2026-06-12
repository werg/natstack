import type { Suite } from "../run.js";
import { panelLifecycle } from "./panelLifecycle.js";
import { panelViewport } from "./panelViewport.js";
import { chatTranscript } from "./chatTranscript.js";
import { spectrolite } from "./spectrolite.js";
import { terminal } from "./terminal.js";

export { panelLifecycle, panelViewport, chatTranscript, spectrolite, terminal };

/** All built-in ported E2E suites. */
export function allSuites(): Suite[] {
  return [panelLifecycle, panelViewport, chatTranscript, spectrolite, terminal];
}
