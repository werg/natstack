import * as path from "path";
import * as fs from "fs";
import { app, dialog } from "electron";
import { z } from "zod";
import type { ServiceDefinition } from "../serviceDefinition.js";
import type { WorkspaceValidation } from "../../shared/types.js";
import { loadWorkspaceConfig } from "../workspace/loader.js";
import { getCentralData } from "../centralData.js";

export function createWorkspaceService(): ServiceDefinition {
  return {
    name: "workspace",
    description: "Workspace CRUD, folder dialogs",
    policy: { allowed: ["shell"] },
    methods: {
      validatePath: { args: z.tuple([z.string()]) },
      openFolderDialog: { args: z.tuple([]) },
      create: { args: z.tuple([z.string(), z.string()]) },
      select: { args: z.tuple([z.string()]) },
    },
    handler: async (_ctx, method, args) => {
      switch (method) {
        case "validatePath": {
          const workspacePath = args[0] as string;
          const resolvedPath = path.resolve(workspacePath);
          const configPath = path.join(resolvedPath, "natstack.yml");

          if (!fs.existsSync(resolvedPath)) {
            return {
              path: resolvedPath,
              name: path.basename(resolvedPath),
              isValid: false,
              hasConfig: false,
              error: "Directory does not exist",
            } as WorkspaceValidation;
          }

          try {
            const stats = fs.statSync(resolvedPath);
            if (!stats.isDirectory()) {
              return {
                path: resolvedPath,
                name: path.basename(resolvedPath),
                isValid: false,
                hasConfig: false,
                error: "Path is not a directory",
              } as WorkspaceValidation;
            }
          } catch (error) {
            return {
              path: resolvedPath,
              name: path.basename(resolvedPath),
              isValid: false,
              hasConfig: false,
              error: error instanceof Error ? error.message : "Failed to access path",
            } as WorkspaceValidation;
          }

          const hasConfig = fs.existsSync(configPath);
          let name = path.basename(resolvedPath);
          let errorMessage: string | undefined;

          if (hasConfig) {
            try {
              const config = loadWorkspaceConfig(resolvedPath, { createIfMissing: false });
              name = config.id || name;
            } catch (error) {
              errorMessage = `Invalid workspace config: ${error instanceof Error ? error.message : String(error)}`;
            }
          }

          return {
            path: resolvedPath,
            name,
            isValid: !errorMessage,
            hasConfig,
            error: errorMessage,
          } as WorkspaceValidation;
        }

        case "openFolderDialog": {
          const result = await dialog.showOpenDialog({
            properties: ["openDirectory", "createDirectory"],
            title: "Select Workspace Folder",
          });
          return result.canceled ? null : result.filePaths[0] ?? null;
        }

        case "create": {
          const [workspacePath, name] = args as [string, string];
          const resolvedPath = path.resolve(workspacePath);

          try {
            fs.mkdirSync(resolvedPath, { recursive: true });
            fs.mkdirSync(path.join(resolvedPath, "panels"), { recursive: true });
            fs.mkdirSync(path.join(resolvedPath, ".cache"), { recursive: true });

            const randomPort = 49152 + Math.floor(Math.random() * 16383);
            const configContent = `# NatStack Workspace Configuration
id: ${name}

git:
  port: ${randomPort}
`;
            fs.writeFileSync(path.join(resolvedPath, "natstack.yml"), configContent, "utf-8");

            return {
              path: resolvedPath,
              name,
              isValid: true,
              hasConfig: true,
            } as WorkspaceValidation;
          } catch (error) {
            return {
              path: resolvedPath,
              name,
              isValid: false,
              hasConfig: false,
              error: error instanceof Error ? error.message : String(error),
            } as WorkspaceValidation;
          }
        }

        case "select": {
          const workspacePath = args[0] as string;
          const centralData = getCentralData();
          try {
            const config = loadWorkspaceConfig(workspacePath, { createIfMissing: false });
            centralData.addRecentWorkspace(workspacePath, config.id);
          } catch {
            centralData.addRecentWorkspace(workspacePath, path.basename(workspacePath));
          }

          app.relaunch({ args: [...process.argv.slice(1), `--workspace=${workspacePath}`] });
          app.exit(0);
          return;
        }

        default:
          throw new Error(`Unknown workspace method: ${method}`);
      }
    },
  };
}
