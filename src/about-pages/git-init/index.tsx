/**
 * Git Init Shell Page - Initialize git repository for non-repo panel folders.
 *
 * Navigated to by the build pipeline when a panel folder is not a git repository.
 * Uses stateArgs.repoPath to show the init UI.
 * "Continue Build" calls panel.initGitRepo which navigates back to trigger rebuild.
 */

import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import { Theme } from "@radix-ui/themes";
import { id, rpc, getStateArgs } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import { GitInitView } from "./GitInitView";

function App() {
  const theme = usePanelTheme();
  const { repoPath } = getStateArgs<{ repoPath: string }>();

  const handleContinueBuild = () => {
    rpc.call("main", "panel.initGitRepo", id);
  };

  return (
    <Theme appearance={theme} radius="medium">
      <GitInitView panelId={id} repoPath={repoPath} onContinueBuild={handleContinueBuild} theme={theme} />
    </Theme>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
