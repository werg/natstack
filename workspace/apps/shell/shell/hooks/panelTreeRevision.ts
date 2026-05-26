import type { PanelTreeSnapshot } from "@natstack/shared/types";

export function coercePanelTreeUpdate(
  data: unknown,
  latestRevision: number
): PanelTreeSnapshot | null {
  if (
    !data ||
    typeof data !== "object" ||
    typeof (data as { revision?: unknown }).revision !== "number" ||
    !Array.isArray((data as { rootPanels?: unknown }).rootPanels)
  ) {
    return null;
  }
  const snapshot = data as PanelTreeSnapshot;
  return snapshot.revision >= latestRevision ? snapshot : null;
}
