/**
 * Git Init Shell Page - Initialize git repository for non-repo panel folders.
 *
 * Navigated to by the build pipeline when a panel folder is not a git repository.
 * Uses stateArgs.repoPath to show the init UI.
 * "Continue Build" calls panel.initGitRepo which navigates back to trigger rebuild.
 */
import { createRoot } from "react-dom/client";
import { id, rpc, getStateArgs } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import { AboutThemeRoot } from "@workspace/about-shared/ui";
import { GitInitView } from "./GitInitView";

function App() {
  const theme = usePanelTheme();
  const { repoPath } = getStateArgs<{ repoPath: string }>();

  const handleContinueBuild = () => {
    void rpc
      .call("main", "panel.initGitRepo", [id])
      .catch((err: unknown) => console.error("[GitInit] Failed to init git repo:", err));
  };

  return (
    <GitInitView
      panelId={id}
      repoPath={repoPath}
      onContinueBuild={handleContinueBuild}
      theme={theme}
    />
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
