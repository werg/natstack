/**
 * Dirty Repo Shell Page - Git UI for panels with uncommitted changes.
 *
 * Navigated to by the build pipeline when a panel's worktree is dirty.
 * Uses stateArgs.repoPath to show the git status and commit UI.
 * "Continue Build" calls panel.retryDirtyBuild which navigates back to trigger rebuild.
 */

import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import { Theme } from "@radix-ui/themes";
import { id, rpc, getStateArgs } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";
import { DirtyRepoView } from "./DirtyRepoView";

function App() {
  const theme = usePanelTheme();
  const { repoPath } = getStateArgs<{ repoPath: string }>();

  const handleRetryBuild = () => {
    // `id` is the raw panelId. rpc.selfId is "panel:<id>".
    rpc.call("main", "panel.retryDirtyBuild", id);
  };

  return (
    <Theme appearance={theme} radius="medium">
      <DirtyRepoView panelId={id} repoPath={repoPath} onRetryBuild={handleRetryBuild} theme={theme} />
    </Theme>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
