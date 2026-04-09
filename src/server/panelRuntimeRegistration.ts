/**
 * Panel runtime registration for shell-owned panel state.
 *
 * The server still owns shared services like builds, workspace metadata,
 * filesystem access, and token minting, but panel trees no longer live here.
 */

import { z } from "zod";
import type { ServiceContainer } from "@natstack/shared/serviceContainer";
import type { ServiceDispatcher } from "@natstack/shared/serviceDispatcher";
import type { TokenManager } from "@natstack/shared/tokenManager";
import type { Workspace, WorkspaceConfig } from "@natstack/shared/workspace/types";
import type { GitServer } from "@natstack/git-server";
import type { CentralDataManager } from "@natstack/shared/centralData";
import type { HostConfig } from "@natstack/shared/hostConfig";

export interface CommonDeps {
  container: ServiceContainer;
  dispatcher: ServiceDispatcher;
  tokenManager: TokenManager;
  workspace: Workspace;
  workspacePath: string;
  workspaceConfig: WorkspaceConfig;
  gitServer: GitServer;
  adminToken: string;
  centralData: CentralDataManager | null;
  args: { panelPort?: number; servePanels?: boolean };
  hostConfig: HostConfig;
  isIpcMode: boolean;
  requestRelaunch?: (name: string) => void;
}

export async function registerPanelServices(deps: CommonDeps): Promise<void> {
  const {
    container,
    dispatcher,
    tokenManager,
    workspace,
    workspacePath,
    workspaceConfig,
    gitServer,
    adminToken,
    centralData,
    args,
    hostConfig,
  } = deps;
  const path = await import("path");
  const { rpcService } = await import("@natstack/shared/managedService");

  {
    const { createPanelService } = await import("./services/panelService.js");
    const { createPanelPersistence } = await import("@natstack/shared/db/panelPersistence");
    const { createPanelSearchIndex } = await import("@natstack/shared/db/panelSearchIndex");

    container.register({
      name: "panelService",
      dependencies: ["fsService", "rpcServer"],
      async start(resolve) {
        const fsServiceInst = resolve<import("@natstack/shared/fsService").FsService>("fsService")!;
        const { server: rpcSrv } = resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")!;
        const getRpcPort = () => rpcSrv.getPort() ?? 0;
        const persistence = createPanelPersistence({ statePath: workspace.statePath, workspaceId: workspace.config.id });
        const searchIndex = createPanelSearchIndex(persistence);
        const wkrdPort = resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")?.getPort() ?? 0;
        const { protocol, externalHost } = hostConfig;
        const wsProto = protocol === "https" ? "wss" : "ws";
        const urlConfig = new (await import("./services/panelService.js")).PanelUrlConfig({
          protocol,
          externalHost,
          gitBaseUrl: `${protocol}://${externalHost}:${gitServer.getPort()}`,
          pubsubBaseUrl: wkrdPort ? `${wsProto}://default.${externalHost}:${wkrdPort}` : "",
          gatewayPort: 0,
        });

        return {
          persistence,
          searchIndex,
          urlConfig,
          definition: createPanelService({
            persistence,
            searchIndex,
            tokenManager,
            fsService: fsServiceInst,
            gitServer,
            workspacePath,
            getRpcPort,
            workerdPort: wkrdPort,
            urlConfig,
          }),
        };
      },
      getServiceDefinition() {
        const inst = container.get<{ definition: import("@natstack/shared/serviceDefinition").ServiceDefinition }>("panelService");
        return inst?.definition;
      },
    });
  }

  {
    const { createWorkspaceService } = await import("./services/workspaceService.js");
    const { createWorkspaceConfigManager, createAndRegisterWorkspace, deleteWorkspaceDir } = await import("@natstack/shared/workspace/loader");
    const wsConfigPath = path.join(workspacePath, "natstack.yml");
    const wsConfigManager = createWorkspaceConfigManager(wsConfigPath, workspaceConfig);

    container.register(rpcService(createWorkspaceService({
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
    })));
  }

  {
    const { PanelHttpServer } = await import("./panelHttpServer.js");
    container.register({
      name: "panelHttpServer",
      async start() {
        const server = new PanelHttpServer(hostConfig.bindHost, adminToken, hostConfig.externalHost, hostConfig.protocol);
        if (deps.isIpcMode) {
          let envPanelPort: number | undefined;
          if (process.env["NATSTACK_PANEL_PORT"]) {
            envPanelPort = parseInt(process.env["NATSTACK_PANEL_PORT"], 10);
            if (isNaN(envPanelPort)) {
              console.warn("[Server] NATSTACK_PANEL_PORT is not a valid number, ignoring");
              envPanelPort = undefined;
            }
          }
          const port = await server.start(args.panelPort ?? envPanelPort ?? 0);
          return { server, port };
        }

        server.initHandlers();
        return { server, port: 0 };
      },
      async stop(instance: { server: import("./panelHttpServer.js").PanelHttpServer; port: number }) {
        await instance?.server?.stop();
      },
    });
  }

  container.register({
    name: "panelHttpWiring",
    dependencies: ["panelHttpServer", "buildSystem", "rpcServer"],
    async start(resolve) {
      const { server: panelHttpServer } = resolve<{ server: import("./panelHttpServer.js").PanelHttpServer }>("panelHttpServer")!;
      const buildSystem = resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")!;
      const { server: rpcServer } = resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")!;

      const graph = buildSystem.getGraph();
      const panelNodes = graph.allNodes().filter((n) => n.kind === "panel");
      const sanitize = (s: string) =>
        s.toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
      const rawEntries = panelNodes.map((n) => ({
        subdomain: sanitize(n.relativePath.split("/").pop() ?? n.relativePath) || "panel",
        source: n.relativePath,
        name: n.manifest.title ?? n.name,
      }));
      const counts = new Map<string, number>();
      for (const entry of rawEntries) counts.set(entry.subdomain, (counts.get(entry.subdomain) ?? 0) + 1);
      for (const entry of rawEntries) {
        if ((counts.get(entry.subdomain) ?? 0) > 1) entry.subdomain = sanitize(entry.source);
      }
      const assigned = new Set<string>();
      for (const entry of rawEntries) {
        let candidate = entry.subdomain.slice(0, 63).replace(/-$/, "");
        let suffix = 1;
        while (assigned.has(candidate)) {
          const tag = `-${suffix}`;
          candidate = entry.subdomain.slice(0, 63 - tag.length).replace(/-$/, "") + tag;
          suffix++;
        }
        entry.subdomain = candidate;
        assigned.add(candidate);
      }
      panelHttpServer.populateSourceRegistry(rawEntries);

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
        fsServiceInstance = resolve<import("@natstack/shared/fsService").FsService>("fsService")!;
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
        return {
          name: "fs",
          description: "Per-context filesystem operations (sandboxed to context folder)",
          policy: { allowed: ["panel", "server", "worker"] },
          methods: {
            readFile: fsMethodSchema, writeFile: fsMethodSchema,
            readdir: fsMethodSchema, mkdir: fsMethodSchema,
            stat: fsMethodSchema, open: fsMethodSchema,
            close: fsMethodSchema, read: fsMethodSchema, write: fsMethodSchema,
            bindContext: bindContextSchema,
            mktemp: mktempSchema,
          },
          handler: async (ctx, method, serviceArgs) => {
            return handleFsCall(fsServiceInstance, ctx, method, serviceArgs as unknown[]);
          },
        };
      },
    });
  }
}
