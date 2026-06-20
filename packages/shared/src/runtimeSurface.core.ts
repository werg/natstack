/**
 * coreRuntimeSurface — the entries byte-identical in BOTH the panel and worker
 * runtime manifests, derived from `portableRuntimeSurface` (the single source of
 * truth) by dropping the few entries whose description differs per target
 * (workspace / openPanel / listPanels / getPanelHandle / panelTree), which the
 * per-target manifests re-add with their own wording.
 *
 * The portable surface now includes `callMain` + `parent`/`getParent`/
 * `getParentWithContract` (real on eval too) and NO longer includes `expose`
 * (use `rpc.expose`) or the `requestApproval`/`revokeApproval`/`listApprovals`
 * aliases (use `approvals.*`).
 */

import type { RuntimeSurfaceEntry } from "./runtimeSurface.js";
import { portableExports, PER_TARGET_DESCRIPTION_KEYS } from "./runtimeSurface.portable.js";

// Re-export the shared member arrays so existing manifest imports keep working.
export {
  WORKERS_MEMBERS,
  WORKSPACE_MEMBERS,
  CREDENTIALS_MEMBERS,
  GIT_MEMBERS,
  VCS_MEMBERS,
  VCS_DESCRIPTION,
  GAD_MEMBERS,
  WEBHOOKS_MEMBERS,
  EXTENSIONS_MEMBERS,
  APPROVALS_MEMBERS,
  NOTIFICATIONS_MEMBERS,
  PANEL_TREE_MEMBERS,
} from "./runtimeSurface.portable.js";

const perTarget = new Set<string>(PER_TARGET_DESCRIPTION_KEYS);

/**
 * Entries identical in both panel & worker manifests. Per-target manifests spread
 * this then layer their own extras (and the description-differing panel-tree /
 * open-panel / workspace entries).
 */
export const coreRuntimeSurface: Record<string, RuntimeSurfaceEntry> = Object.fromEntries(
  Object.entries(portableExports).filter(([key]) => !perTarget.has(key))
);
