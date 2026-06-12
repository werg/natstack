/**
 * Dirty Repo Shell Page - Git UI for panels with uncommitted changes.
 *
 * Navigated to by the build pipeline when a panel's worktree is dirty.
 * Uses stateArgs.repoPath to show the git status and commit UI.
 * "Continue Build" calls panel.rebuildPanel to trigger a rebuild.
 */
import { createRoot } from "react-dom/client";
import { id, rpc, getStateArgs } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import { AboutThemeRoot } from "@workspace/about-shared/ui";
import { DirtyRepoView } from "./DirtyRepoView";

function App() {
  const theme = usePanelTheme();
  const { repoPath } = getStateArgs<{ repoPath: string }>();

  const handleRetryBuild = () => {
    void rpc
      .call("main", "panel.rebuildPanel", [id])
      .catch((err: unknown) => console.error("[DirtyRepo] Failed to rebuild:", err));
  };

  return (
    <DirtyRepoView panelId={id} repoPath={repoPath} onRetryBuild={handleRetryBuild} theme={theme} />
  );
}

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <AboutThemeRoot>
      <App />
    </AboutThemeRoot>
  );
}
