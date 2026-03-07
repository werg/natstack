import { dialog } from "electron";
import { existsSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { join, resolve } from "path";
import { execSync } from "child_process";
import { z } from "zod";
import type { ServiceDefinition } from "../serviceDefinition.js";
import type { PanelManager } from "../panelManager.js";
import type { CdpServer } from "../cdpServer.js";
import type { ViewManager } from "../viewManager.js";
import type { Workspace } from "../workspace/types.js";
import { handleCommonBridgeMethod } from "../../shared/bridgeHandlersCommon.js";

export function createBridgeService(deps: {
  panelManager: PanelManager;
  cdpServer: CdpServer;
  getViewManager: () => ViewManager;
  workspace: Workspace | null;
}): ServiceDefinition {
  return {
    name: "bridge",
    description: "Panel lifecycle (createPanel, close, navigation)",
    policy: { allowed: ["panel", "shell", "server"] },
    methods: {
      closeSelf: { args: z.tuple([]) },
      getInfo: { args: z.tuple([]) },
      setStateArgs: { args: z.tuple([z.record(z.unknown())]) },
      focusPanel: { args: z.tuple([z.string().optional()]) },
      getBootstrapConfig: { args: z.tuple([]) },
      getWorkspaceTree: { args: z.tuple([]) },
      listBranches: { args: z.tuple([z.string()]) },
      listCommits: { args: z.tuple([z.string(), z.string().optional(), z.number().optional()]) },
      openFolderDialog: { args: z.tuple([z.object({ title: z.string().optional() }).optional()]) },
      listAgents: { args: z.tuple([]) },
      createRepo: { args: z.tuple([z.string()]) },
      openDevtools: { args: z.tuple([]) },
    },
    handler: async (ctx, method, args) => {
      const pm = deps.panelManager;
      const callerId = ctx.callerId;

      // Try common handlers first (shared with headless mode)
      const common = await handleCommonBridgeMethod(pm, callerId, method, args as unknown[]);
      if (common.handled) return common.result;

      // Electron-specific handlers
      switch (method) {
        case "getWorkspaceTree":
          return pm.getWorkspaceTree();

        case "listBranches": {
          const [repoPath] = args as [string];
          return pm.listBranches(repoPath);
        }

        case "listCommits": {
          const [repoPath, ref, limit] = args as [string, string?, number?];
          return pm.listCommits(repoPath, ref, limit);
        }

        case "openFolderDialog": {
          const [options] = (args ?? []) as [{ title?: string }?];
          const result = await dialog.showOpenDialog({
            properties: ["openDirectory", "createDirectory"],
            title: options?.title ?? "Select Folder",
          });
          return result.canceled ? null : result.filePaths[0] ?? null;
        }

        case "listAgents":
          return pm.listAgents();

        case "createRepo": {
          const [repoPath] = args as [string];
          if (!repoPath?.trim()) throw new Error("Repo path is required");
          const workspace = deps.workspace;
          if (!workspace) throw new Error("No active workspace");
          const absolutePath = resolve(workspace.path, repoPath);
          if (!absolutePath.startsWith(workspace.path + "/") && absolutePath !== workspace.path) {
            throw new Error(`Invalid repo path: escapes workspace root`);
          }
          if (existsSync(absolutePath)) throw new Error(`Path already exists: ${repoPath}`);
          await mkdir(absolutePath, { recursive: true });
          execSync("git init", { cwd: absolutePath, stdio: "pipe" });
          const repoName = repoPath.split("/").pop() ?? "project";
          await writeFile(join(absolutePath, "README.md"), `# ${repoName}\n\nA new NatStack project.\n`, "utf-8");
          execSync("git add README.md", { cwd: absolutePath, stdio: "pipe" });
          execSync('git commit -m "Initial commit"', { cwd: absolutePath, stdio: "pipe" });
          return;
        }

        case "openDevtools": {
          const vm = deps.getViewManager();
          vm.openDevTools(callerId);
          return;
        }

        default:
          throw new Error(`Unknown bridge method: ${method}`);
      }
    },
  };
}
