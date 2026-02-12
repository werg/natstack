import { useAtomValue, useSetAtom } from "jotai";
import { Dialog } from "@radix-ui/themes";

import { workspaceChooserDialogOpenAtom } from "../state/appModeAtoms";
import { PanelApp } from "./PanelApp";
import { WorkspaceChooser } from "./WorkspaceChooser";
import { WorkspaceWizard } from "./WorkspaceWizard";

/**
 * Main mode: shows panel app with dialogs for workspace chooser and wizard.
 * Extracted for React.lazy code splitting — this pulls in PanelApp, PanelStack,
 * TitleBar, LazyPanelTreeSidebar, @dnd-kit/*, and all transitive deps.
 */
export default function MainMode() {
  const workspaceChooserOpen = useAtomValue(workspaceChooserDialogOpenAtom);
  const setWorkspaceChooserOpen = useSetAtom(workspaceChooserDialogOpenAtom);

  return (
    <>
      <PanelApp />
      <WorkspaceWizard />

      {/* Workspace Chooser Dialog (for switching workspaces in main mode) */}
      <Dialog.Root open={workspaceChooserOpen} onOpenChange={setWorkspaceChooserOpen}>
        <Dialog.Content maxWidth="600px">
          <WorkspaceChooser />
        </Dialog.Content>
      </Dialog.Root>
    </>
  );
}
