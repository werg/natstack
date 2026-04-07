export interface ShellBridgeTarget {
  getInfo(panelId: string): unknown;
  setStateArgs(panelId: string, updates: Record<string, unknown>): Promise<unknown> | unknown;
  closePanel(panelId: string): Promise<void> | void;
  closeChild(panelId: string, childId: string): Promise<void> | void;
  focusPanel(panelId: string): Promise<void> | void;
  createBrowserPanel(
    panelId: string,
    url: string,
    options?: { name?: string; focus?: boolean },
  ): Promise<{ id: string; title: string }> | { id: string; title: string };
}

export function createBridgeHandlers(target: ShellBridgeTarget) {
  return {
    getInfo(panelId: string) {
      return target.getInfo(panelId);
    },
    setStateArgs(panelId: string, updates: Record<string, unknown>) {
      return target.setStateArgs(panelId, updates);
    },
    closeSelf(panelId: string) {
      return target.closePanel(panelId);
    },
    closeChild(panelId: string, childId: string) {
      return target.closeChild(panelId, childId);
    },
    focusPanel(panelId: string) {
      return target.focusPanel(panelId);
    },
    createBrowserPanel(panelId: string, url: string, options?: { name?: string; focus?: boolean }) {
      return target.createBrowserPanel(panelId, url, options);
    },
  };
}
