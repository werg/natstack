import * as fs from "fs";
import * as path from "path";
import type {
  LocalPanelViewState,
  LocalPanelViewStateStore,
} from "@natstack/shared/shell/panelManager";

export function createElectronLocalViewStateStore(statePath: string): LocalPanelViewStateStore {
  const filePath = path.join(statePath, "local-view-state", "panels.json");
  return {
    async load() {
      try {
        const parsed = JSON.parse(
          await fs.promises.readFile(filePath, "utf8")
        ) as Partial<LocalPanelViewState>;
        return {
          collapsedIds: Array.isArray(parsed.collapsedIds)
            ? parsed.collapsedIds.filter((id): id is string => typeof id === "string")
            : [],
          focusedPanelId: typeof parsed.focusedPanelId === "string" ? parsed.focusedPanelId : null,
          panelTitles:
            parsed.panelTitles && typeof parsed.panelTitles === "object"
              ? Object.fromEntries(
                  Object.entries(parsed.panelTitles).filter(
                    (entry): entry is [string, { source: string; title: string }] => {
                      const value = entry[1] as { source?: unknown; title?: unknown };
                      return typeof value.source === "string" && typeof value.title === "string";
                    }
                  )
                )
              : {},
        };
      } catch {
        return null;
      }
    },
    async save(state) {
      await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
      await fs.promises.writeFile(
        filePath,
        JSON.stringify(
          {
            collapsedIds: state.collapsedIds,
            focusedPanelId: state.focusedPanelId ?? null,
            panelTitles: state.panelTitles ?? {},
          },
          null,
          2
        )
      );
    },
  };
}
