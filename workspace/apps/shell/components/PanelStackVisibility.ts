import type { PanelArtifacts } from "@natstack/shared/types";

export function shouldShowPanelView(artifacts: PanelArtifacts | undefined): boolean {
  return Boolean(
    artifacts?.htmlPath &&
    artifacts.buildState !== "pending" &&
    artifacts.buildState !== "error" &&
    !artifacts.error
  );
}
