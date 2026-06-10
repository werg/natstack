import type { PanelHandle } from "@workspace/runtime";

export function assertBrowserPanelHandle<T extends Pick<PanelHandle, "id" | "kind">>(
  handle: T,
  label = "panel handle"
): T & { kind: "browser" } {
  if (handle.kind !== "browser") {
    throw new Error(
      `${label} ${handle.id} is a ${handle.kind} panel, not a browser panel. ` +
        `Open a browser child with panelTree.open("https://...") or openPanel("https://...") ` +
        `and automate that returned handle. Do not drive panelTree.self() through CDP.`
    );
  }
  return handle as T & { kind: "browser" };
}

export async function refreshBrowserPanelHandle<T extends PanelHandle>(
  handle: T,
  label = "panel handle"
): Promise<T & { kind: "browser" }> {
  const refreshed = (await handle.refresh()) as T;
  return assertBrowserPanelHandle(refreshed, label);
}
