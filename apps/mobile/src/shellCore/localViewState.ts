import type {
  LocalPanelViewState,
  LocalPanelViewStateStore,
} from "@natstack/shared/shell/panelManager";

declare const require: (moduleName: string) => unknown;

interface AsyncStorageLike {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

function getAsyncStorage(): AsyncStorageLike | null {
  try {
    const mod = require("@react-native-async-storage/async-storage") as {
      default?: AsyncStorageLike;
    } & AsyncStorageLike;
    return mod.default ?? mod;
  } catch {
    return null;
  }
}

export function createMobileLocalViewStateStore(workspaceId: string): LocalPanelViewStateStore {
  const key = `natstack:workspace:${workspaceId}:local-view-state`;
  return {
    async load() {
      const storage = getAsyncStorage();
      if (!storage) return null;
      try {
        const parsed = JSON.parse(
          (await storage.getItem(key)) ?? "{}"
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
      const storage = getAsyncStorage();
      if (!storage) return;
      await storage.setItem(
        key,
        JSON.stringify({
          collapsedIds: state.collapsedIds,
          focusedPanelId: state.focusedPanelId ?? null,
          panelTitles: state.panelTitles ?? {},
        })
      );
    },
  };
}
