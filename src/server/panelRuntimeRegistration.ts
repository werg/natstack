/**
 * Panel runtime registration for shell-owned panel state.
 *
 * The server still owns shared services like builds, workspace metadata,
 * filesystem access, and token minting, but panel trees no longer live here.
 */

import { z } from "zod";
import type { ServiceContainer } from "@natstack/shared/serviceContainer";
import { createVerifiedCaller, type ServiceDispatcher } from "@natstack/shared/serviceDispatcher";
import type { Workspace, WorkspaceConfig } from "@natstack/shared/workspace/types";
import type { CentralDataManager } from "@natstack/shared/centralData";
import type { HostConfig } from "@natstack/shared/hostConfig";
import type { PrincipalRegistry } from "@natstack/shared/principalRegistry";
import type { ConnectionGrantService } from "@natstack/shared/connectionGrants";
import type { ApprovalQueue } from "./services/approvalQueue.js";
import { assertPresent } from "../lintHelpers";

export interface CommonDeps {
  container: ServiceContainer;
  dispatcher: ServiceDispatcher;
  principalRegistry: PrincipalRegistry;
  connectionGrants: ConnectionGrantService;
  workspace: Workspace;
  workspacePath: string;
  workspaceConfig: WorkspaceConfig;
  adminToken: string;
  centralData: CentralDataManager | null;
  hostConfig: HostConfig;
  isIpcMode: boolean;
  requestRelaunch?: (name: string) => void;
  /** IPC proxy: fetch workspace list from Electron main when centralData is null. */
  requestWorkspaceList?: () => Promise<unknown[]>;
  listWorkspaceUnits?: () =>
    | Promise<import("./services/workspaceService.js").WorkspaceUnitStatus[]>
    | import("./services/workspaceService.js").WorkspaceUnitStatus[];
  restartWorkspaceUnit?: (
    ctx: import("@natstack/shared/serviceDispatcher").ServiceContext,
    name: string
  ) => Promise<void>;
  listWorkspaceUnitLogs?: (
    name: string,
    opts?: {
      since?: number;
      level?: import("./services/workspaceService.js").WorkspaceUnitLogRecord["level"];
      limit?: number;
    }
  ) =>
    | Promise<import("./services/workspaceService.js").WorkspaceUnitLogRecord[]>
    | import("./services/workspaceService.js").WorkspaceUnitLogRecord[];
  approvalQueue?: Pick<ApprovalQueue, "requestUserland">;
  getEffectiveVersion?: (source: string) => Promise<string | undefined>;
}

export async function registerPanelServices(deps: CommonDeps): Promise<void> {
  const {
    container,
    dispatcher,
    workspace,
    workspacePath,
    workspaceConfig,
    adminToken,
    centralData,
    hostConfig,
  } = deps;
  const path = await import("path");
  const { rpcService } = await import("@natstack/shared/managedService");

  {
    const { createPanelService } = await import("./services/panelService.js");
    const { createPanelPersistenceClient } = await import("./services/panelPersistenceClient.js");

    container.register({
      name: "panelService",
      dependencies: ["fsService"],
      async start(resolve) {
        const fsServiceInst = assertPresent(
          resolve<import("@natstack/shared/fsService").FsService>("fsService")
        );
        const panelPersistenceRpc = {
          call: (service: string, method: string, args: unknown[]) =>
            dispatcher.dispatch(
              { caller: createVerifiedCaller("server", "server") },
              service,
              method,
              args
            ),
        };
        const persistence = createPanelPersistenceClient(panelPersistenceRpc);
        const searchIndex = persistence;
        const { protocol, externalHost } = hostConfig;
        const urlConfig = new (await import("./services/panelService.js")).PanelUrlConfig({
          protocol,
          externalHost,
          gatewayPort: 0,
        });

        return {
          persistence,
          searchIndex,
          urlConfig,
          definition: createPanelService({
            persistence,
            searchIndex,
            fsService: fsServiceInst,
            principalRegistry: deps.principalRegistry,
            connectionGrants: deps.connectionGrants,
            workspacePath,
            urlConfig,
            getEffectiveVersion: deps.getEffectiveVersion,
          }),
        };
      },
      getServiceDefinition() {
        const inst = container.get<{
          definition: import("@natstack/shared/serviceDefinition").ServiceDefinition;
        }>("panelService");
        return inst?.definition;
      },
    });
  }

  {
    const { createWorkspaceService } = await import("./services/workspaceService.js");
    const { createWorkspaceConfigManager, createAndRegisterWorkspace, deleteWorkspaceDir } =
      await import("@natstack/shared/workspace/loader");
    const wsConfigPath = path.join(workspacePath, "meta/natstack.yml");
    const wsConfigManager = createWorkspaceConfigManager(wsConfigPath, workspaceConfig);

    container.register(
      rpcService(
        createWorkspaceService({
          workspace,
          getConfig: wsConfigManager.get,
          setConfigField: wsConfigManager.set as (key: string, value: unknown) => void,
          centralData: centralData ?? null,
          createWorkspace: (name, opts) => {
            if (!centralData) throw new Error("Workspace creation not available");
            return createAndRegisterWorkspace(name, centralData, opts);
          },
          deleteWorkspaceDir,
          requestRelaunch: deps.requestRelaunch,
          requestWorkspaceList: deps.requestWorkspaceList,
          listUnits: deps.listWorkspaceUnits,
          restartUnit: deps.restartWorkspaceUnit,
          listUnitLogs: deps.listWorkspaceUnitLogs,
          approvalQueue: deps.approvalQueue,
        })
      )
    );
  }

  {
    const { PanelHttpServer } = await import("./panelHttpServer.js");
    container.register({
      name: "panelHttpServer",
      async start() {
        const server = new PanelHttpServer(
          hostConfig.bindHost,
          adminToken,
          hostConfig.externalHost,
          hostConfig.protocol
        );
        server.initHandlers();
        return { server, port: 0 };
      },
      async stop(instance: {
        server: import("./panelHttpServer.js").PanelHttpServer;
        port: number;
      }) {
        await instance?.server?.stop();
      },
    });
  }

  container.register({
    name: "panelHttpWiring",
    dependencies: ["panelHttpServer", "buildSystem", "rpcServer"],
    async start(resolve) {
      const { server: panelHttpServer } = assertPresent(
        resolve<{
          server: import("./panelHttpServer.js").PanelHttpServer;
        }>("panelHttpServer")
      );
      const buildSystem = assertPresent(
        resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")
      );
      const { server: rpcServer } = assertPresent(
        resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")
      );

      const graph = buildSystem.getGraph();
      const panelNodes = graph.allNodes().filter((n) => n.kind === "panel");
      const entries = panelNodes.map((n) => ({
        source: n.relativePath,
        name: n.manifest.title ?? n.name,
      }));
      panelHttpServer.populateSourceRegistry(entries);

      panelHttpServer.setCallbacks({
        listPanels: () => [],
        getBuild: (source, ref) => buildSystem.getBuild(source, ref),
        onBuildComplete: (source, error) => {
          rpcServer.broadcastToControlPlane({
            type: "ws:event",
            event: "build:complete",
            payload: { source, error },
          } as import("@natstack/shared/ws/protocol").WsServerMessage);
        },
      });

      buildSystem.onPushBuild((source) => {
        panelHttpServer.invalidateBuild(source);
      });
    },
  });

  {
    const { handleFsCall } = await import("@natstack/shared/fsService");
    let fsServiceInstance: import("@natstack/shared/fsService").FsService;
    container.register({
      name: "fsRpc",
      dependencies: ["fsService"],
      async start(resolve) {
        fsServiceInstance = assertPresent(
          resolve<import("@natstack/shared/fsService").FsService>("fsService")
        );
      },
      getServiceDefinition() {
        const fsMethodSchema = { args: z.tuple([z.string()]).rest(z.unknown()) };
        // `bindContext` is special: it takes exactly one string (the contextId)
        // and is invoked before any caller→context mapping exists, so its args
        // must validate against a bare tuple rather than the generic
        // `[string, ...unknown[]]` path-first shape.
        const bindContextSchema = { args: z.tuple([z.string()]) };
        // `mktemp` takes an optional prefix string; no leading path arg.
        const mktempSchema = { args: z.tuple([z.string().optional()]) };
        // Per-method policy for sandbox-escape primitives. `symlink` and
        // `chown` were Wave-1 audit findings (#38, #39): even though the
        // implementation in `fsService.ts` was hardened (sandbox-target
        // resolution, lstat parent walk), exposing them to `panel` /
        // `worker` callers gives attackers a TOCTOU primitive. Restrict
        // both to trusted native-code callers only — internal server callers
        // needing these ops can bypass the dispatcher, and extensions already
        // have equivalent raw Node access after install approval.
        return {
          name: "fs",
          description: "Per-context filesystem operations (sandboxed to context folder)",
          policy: { allowed: ["panel", "server", "worker", "extension"] },
          methods: {
            readFile: fsMethodSchema,
            writeFile: fsMethodSchema,
            readdir: fsMethodSchema,
            mkdir: fsMethodSchema,
            stat: fsMethodSchema,
            open: fsMethodSchema,
            close: fsMethodSchema,
            read: fsMethodSchema,
            write: fsMethodSchema,
            bindContext: bindContextSchema,
            mktemp: mktempSchema,
            symlink: { ...fsMethodSchema, policy: { allowed: ["shell", "extension"] } },
            chown: { ...fsMethodSchema, policy: { allowed: ["shell", "extension"] } },
          },
          handler: async (ctx, method, serviceArgs) => {
            return handleFsCall(fsServiceInstance, ctx, method, serviceArgs as unknown[]);
          },
        };
      },
    });
  }
}
