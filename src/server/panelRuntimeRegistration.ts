/**
 * Panel Runtime Registration — server service wiring for panel lifecycle.
 *
 * Extracts all panel-runtime service registration from server/index.ts.
 * Two entry points:
 * - registerPanelServices: shared services (panel, panelHttp, fs, bridge in IPC mode)
 * - registerStandalonePanelRuntime: standalone mode (onDemandCreate → panel.create, CDP bridge)
 */

import { z } from "zod";
import type { ServiceContainer } from "../shared/serviceContainer.js";
import type { ServiceDispatcher } from "../shared/serviceDispatcher.js";
import type { TokenManager } from "../shared/tokenManager.js";
import type { Workspace, WorkspaceConfig } from "../shared/workspace/types.js";
import type { GitServer } from "@natstack/git-server";
import type { CentralDataManager } from "../shared/centralData.js";
import type { HostConfig } from "../shared/hostConfig.js";

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
  /** True when running as Electron's child process (IPC mode). */
  isIpcMode: boolean;
  /** EventService for emitting events (optional, used in standalone mode). */
  eventService?: import("../shared/eventsService.js").EventService;
}

/**
 * Register panel service, PanelHttpServer, workspace info, FS RPC — shared by both modes.
 */
export async function registerPanelServices(deps: CommonDeps): Promise<void> {
  const { container, dispatcher, tokenManager, workspace, workspacePath, workspaceConfig, gitServer, adminToken, centralData, args, hostConfig } = deps;
  const path = await import("path");
  const { rpcService } = await import("../shared/managedService.js");

  // ===========================================================================
  // Panel service (always registered — server is the sole persistence writer)
  // ===========================================================================

  {
    const { createPanelService } = await import("./services/panelService.js");
    const { createPanelPersistence } = await import("../shared/db/panelPersistence.js");
    const { createPanelSearchIndex } = await import("../shared/db/panelSearchIndex.js");

    container.register({
      name: "panelService",
      dependencies: ["fsService", "rpcServer"],
      async start(resolve) {
        const fsServiceInst = resolve<import("../shared/fsService.js").FsService>("fsService")!;
        const { server: rpcSrv } = resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")!;
        const getRpcPort = () => rpcSrv.getPort() ?? 0;
        const persistence = createPanelPersistence({ statePath: workspace.statePath, workspaceId: workspace.config.id });
        const searchIndex = createPanelSearchIndex(persistence);
        const wkrdPort = resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")?.getPort() ?? 0;

        // Panel-facing URLs: start with externalHost, then updated via
        // finalizeForGateway() after the gateway binds in standalone mode.
        // Use externalHost (not internalHost) so remote clients get correct URLs.
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
        const inst = container.get<{ definition: import("../shared/serviceDefinition.js").ServiceDefinition }>("panelService");
        return inst?.definition;
      },
    });
  }

  // ===========================================================================
  // WorkspaceInfo service (always registered)
  // ===========================================================================

  {
    const { createWorkspaceInfoService } = await import("./services/workspaceInfoService.js");
    const { createWorkspaceConfigManager, createAndRegisterWorkspace, deleteWorkspaceDir } = await import("../shared/workspace/loader.js");
    const wsConfigPath = path.join(workspacePath, "natstack.yml");
    const wsConfigManager = createWorkspaceConfigManager(wsConfigPath, workspaceConfig);

    container.register(rpcService(createWorkspaceInfoService({
      workspace,
      getConfig: wsConfigManager.get,
      setConfigField: wsConfigManager.set as (key: string, value: unknown) => void,
      centralData: centralData ?? null,
      createWorkspace: (name, opts) => {
        if (!centralData) throw new Error("Workspace creation not available");
        return createAndRegisterWorkspace(name, centralData, opts);
      },
      deleteWorkspaceDir,
    })));
  }

  // ===========================================================================
  // PanelHttpServer (always registered — serves panel assets)
  // ===========================================================================

  {
    const { PanelHttpServer } = await import("./panelHttpServer.js");
    container.register({
      name: "panelHttpServer",
      async start() {
        const server = new PanelHttpServer(hostConfig.bindHost, adminToken, hostConfig.externalHost, hostConfig.protocol);
        if (deps.isIpcMode) {
          // IPC mode: bind own socket (Electron proxies panel HTTP requests here)
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
        } else {
          // Standalone mode: gateway owns the socket, dispatches to us
          server.initHandlers();
          return { server, port: 0 };
        }
      },
      async stop(instance: { server: import("./panelHttpServer.js").PanelHttpServer; port: number }) {
        await instance?.server?.stop();
      },
    });

    // PanelHttp RPC service — wraps PanelHttpServer for RPC access
    const { createPanelHttpService } = await import("./services/panelHttpService.js");
    container.register({
      name: "panelHttpRpc",
      dependencies: ["panelHttpServer"],
      async start() {},
      getServiceDefinition() {
        const httpResult = container.get<{ server: import("./panelHttpServer.js").PanelHttpServer }>("panelHttpServer");
        return createPanelHttpService({ panelHttpServer: httpResult.server });
      },
    });
  }

  // ===========================================================================
  // PanelHttpServer callback wiring (universal — IPC + standalone)
  // ===========================================================================

  container.register({
    name: "panelHttpWiring",
    dependencies: ["panelHttpServer", "buildSystem", "rpcServer", "panelService"],
    async start(resolve) {
      const { server: panelHttpServer } = resolve<{ server: import("./panelHttpServer.js").PanelHttpServer }>("panelHttpServer")!;
      const buildSystem = resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")!;
      const { server: rpcServer } = resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")!;
      /** Live RPC port — reads from rpcServer so it reflects the gateway port after startup. */
      const getRpcPort = () => rpcServer.getPort() ?? 0;

      // Populate source registry from build graph
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
      for (const e of rawEntries) counts.set(e.subdomain, (counts.get(e.subdomain) ?? 0) + 1);
      for (const e of rawEntries) {
        if ((counts.get(e.subdomain) ?? 0) > 1) e.subdomain = sanitize(e.source);
      }
      const assigned = new Set<string>();
      for (const e of rawEntries) {
        let candidate = e.subdomain.slice(0, 63).replace(/-$/, "");
        let suffix = 1;
        while (assigned.has(candidate)) {
          const tag = `-${suffix}`;
          candidate = e.subdomain.slice(0, 63 - tag.length).replace(/-$/, "") + tag;
          suffix++;
        }
        e.subdomain = candidate;
        assigned.add(candidate);
      }
      panelHttpServer.populateSourceRegistry(rawEntries);

      // On-demand create coalescing map
      const onDemandInFlight = new Map<string, Promise<any>>();

      panelHttpServer.setCallbacks({
        onDemandCreate: deps.isIpcMode
          ? async () => {
              throw new Error("Panel creation via browser request is not supported in IPC mode. Panels are managed by Electron.");
            }
          : async (source, subdomain) => {
              const inflight = onDemandInFlight.get(subdomain);
              if (inflight) return inflight;

              const promise = (async () => {
                const serverCtx = { callerId: "server:panelHttp", callerKind: "server" as const };
                const result = await dispatcher.dispatch(
                  serverCtx, "panel", "create",
                  [source, { contextId: subdomain, isRoot: true, addAsRoot: true }],
                ) as import("../shared/panelFactory.js").PanelCreateResult;

                return {
                  panelId: result.panelId,
                  rpcPort: getRpcPort(),
                  rpcToken: result.rpcToken,
                };
              })();

              onDemandInFlight.set(subdomain, promise);
              try { return await promise; }
              finally { onDemandInFlight.delete(subdomain); }
            },
        listPanels: () => [], // Standalone overrides; IPC mode panels tracked on Electron side
        getBuild: (source, ref) => buildSystem.getBuild(source, ref),
        onBuildComplete: (source, error) => {
          rpcServer.broadcastToAdmins({
            type: "ws:event",
            event: "build:complete",
            payload: { source, error },
          } as import("../shared/ws/protocol.js").WsServerMessage);
        },
      });

      // Wire push trigger → invalidate build cache + broadcast
      buildSystem.onPushBuild((source) => {
        panelHttpServer.invalidateBuild(source);
      });
    },
  });

  // ===========================================================================
  // Bridge RPC service (IPC mode — server-side bridge for data/persistence)
  // ===========================================================================
  // In IPC mode, panels send bridge.* calls to the server WS. The server
  // handles data/persistence methods here. Electron-only methods (openDevtools,
  // openFolderDialog) are handled via __natstackElectron IPC in the panel
  // preload, not through this service.
  // In standalone mode, registerStandalonePanelRuntime registers its own
  // bridge service with the full standalone implementation.

  if (deps.isIpcMode) {
    const { SERVER_BRIDGE_METHODS } = await import("../shared/bridgeMethodSchemas.js");
    container.register({
      name: "ipcBridge",
      dependencies: ["panelService", "rpcServer"],
      async start() {},
      getServiceDefinition() {
        return {
          name: "bridge",
          description: "Panel lifecycle bridge (IPC mode — server-side data ops)",
          policy: { allowed: ["panel", "shell", "server"] },
          methods: SERVER_BRIDGE_METHODS,
          handler: async (ctx, method, serviceArgs) => {
            // Delegate all bridge methods to the panel service via dispatcher.
            // The panel service handles: closeSelf→close, getInfo, setStateArgs,
            // focusPanel, getBootstrapConfig, getWorkspaceTree, listBranches, etc.
            const args = serviceArgs as unknown[];
            switch (method) {
              case "closeSelf":
                return dispatcher.dispatch(ctx, "panel", "close", [ctx.callerId]);
              case "closeChild": {
                const [childId] = args as [string];
                // Verify caller is the parent
                const panelSvcInst = container.get<{
                  persistence: import("../shared/db/panelPersistence.js").PanelPersistence;
                }>("panelService");
                const parentId = panelSvcInst?.persistence?.getParentId(childId);
                if (parentId !== ctx.callerId) {
                  throw new Error(`Panel ${ctx.callerId} is not the parent of ${childId}`);
                }
                return dispatcher.dispatch(ctx, "panel", "close", [childId]);
              }
              case "getInfo": {
                // Build panel info from persistence
                const panelServiceInst = container.get<{
                  persistence: import("../shared/db/panelPersistence.js").PanelPersistence;
                }>("panelService");
                const panel = panelServiceInst?.persistence?.getPanel(ctx.callerId);
                if (!panel) throw new Error(`Panel not found: ${ctx.callerId}`);
                const snapshot = panel.snapshot;
                return {
                  panelId: ctx.callerId,
                  partition: snapshot.contextId,
                  contextId: snapshot.contextId,
                };
              }
              case "setStateArgs": {
                const [updates] = args as [Record<string, unknown>];
                const validated = await dispatcher.dispatch(ctx, "panel", "updateStateArgs", [ctx.callerId, updates]);
                // Emit stateArgs:updated event back to the panel over server WS
                const rpcResult = container.get<{ server: import("./rpcServer.js").RpcServer }>("rpcServer");
                rpcResult?.server?.sendToClient(ctx.callerId, {
                  type: "ws:event",
                  event: "stateArgs:updated",
                  payload: validated,
                } as import("../shared/ws/protocol.js").WsServerMessage);
                return validated;
              }
              case "focusPanel": {
                // In IPC mode, focus is Electron-owned. Forward to panel service
                // for persistence, but the actual view focusing happens via
                // __natstackElectron.focusPanel from the panel side.
                const [targetId] = args as [string];
                return dispatcher.dispatch(ctx, "panel", "updateSelectedPath", [targetId]);
              }
              case "getBootstrapConfig": {
                // In IPC mode, panels normally get bootstrap config via
                // __natstackElectron.getBootstrapConfig(). This path handles the
                // fallback when __natstackElectron is not available (shouldn't
                // happen in IPC mode, but handles edge cases gracefully).
                const creds = await dispatcher.dispatch(
                  { ...ctx, callerKind: "server" }, "panel", "getCredentials", [ctx.callerId],
                ) as {
                  serverRpcToken: string;
                  gitToken: string;
                  rpcPort: number;
                  workerdPort: number;
                  gitBaseUrl: string;
                  gitConfig: { serverUrl: string; token: string; sourceRepo?: string };
                  pubsubConfig: { serverUrl: string; token: string };
                };
                // Build the full bootstrap config using the panel's persistence data
                const bsPanelSvc = container.get<{
                  persistence: import("../shared/db/panelPersistence.js").PanelPersistence;
                }>("panelService");
                const bsPanel = bsPanelSvc?.persistence?.getPanel(ctx.callerId);
                if (!bsPanel) throw new Error(`Panel not found: ${ctx.callerId}`);
                const snapshot = bsPanel.snapshot;
                return {
                  panelId: ctx.callerId,
                  contextId: snapshot.contextId,
                  parentId: bsPanelSvc?.persistence?.getParentId(ctx.callerId) ?? null,
                  theme: "dark",
                  rpcPort: creds.rpcPort,
                  rpcToken: creds.serverRpcToken,
                  gitConfig: creds.gitConfig,
                  pubsubConfig: creds.pubsubConfig,
                  env: snapshot.options?.env ?? {},
                  stateArgs: snapshot.stateArgs ?? {},
                };
              }
              case "getWorkspaceTree":
                return dispatcher.dispatch({ ...ctx, callerKind: "server" }, "git", "getWorkspaceTree", []);
              case "listBranches": {
                const [repoPath] = args as [string];
                return dispatcher.dispatch({ ...ctx, callerKind: "server" }, "git", "listBranches", [repoPath]);
              }
              case "listCommits": {
                const [repoPath, ref, limit] = args as [string, string?, number?];
                return dispatcher.dispatch({ ...ctx, callerKind: "server" }, "git", "listCommits", [repoPath, ref ?? "HEAD", limit ?? 50]);
              }
              case "createBrowserPanel": {
                // In IPC mode, browser panel creation is Electron-owned
                // Panels call __natstackElectron.createBrowserPanel directly
                throw new Error("createBrowserPanel is handled via Electron IPC in IPC mode");
              }
              case "createRepo": {
                const [repoPath] = args as [string];
                return dispatcher.dispatch({ ...ctx, callerKind: "server" }, "git", "createRepo", [repoPath]);
              }
              case "openExternal":
                throw new Error("openExternal is handled via Electron IPC in IPC mode");
              default:
                throw new Error(`Unknown bridge method: ${method}`);
            }
          },
        };
      },
    });
  }

  // ===========================================================================
  // FS RPC service (always registered — server owns filesystem access)
  // ===========================================================================

  {
    const { handleFsCall } = await import("../shared/fsService.js");
    let fsServiceInstance: import("../shared/fsService.js").FsService;
    container.register({
      name: "fsRpc",
      dependencies: ["fsService"],
      async start(resolve) {
        fsServiceInstance = resolve<import("../shared/fsService.js").FsService>("fsService")!;
      },
      getServiceDefinition() {
        const fsMethodSchema = { args: z.tuple([z.string()]).rest(z.unknown()) };
        return {
          name: "fs",
          description: "Per-context filesystem operations (sandboxed to context folder)",
          policy: { allowed: ["panel", "server", "worker"] },
          methods: {
            readFile: fsMethodSchema, writeFile: fsMethodSchema,
            readdir: fsMethodSchema, mkdir: fsMethodSchema,
            stat: fsMethodSchema, open: fsMethodSchema,
            close: fsMethodSchema, read: fsMethodSchema, write: fsMethodSchema,
          },
          handler: async (ctx, method, serviceArgs) => {
            return handleFsCall(fsServiceInstance, ctx, method, serviceArgs as unknown[]);
          },
        };
      },
    });
  }
}

/**
 * Register standalone-mode panel runtime.
 * Wires onDemandCreate → panel.create via dispatcher, source registry from build graph,
 * CDP bridge, browser service, standalone bridge, disconnect handler.
 */
export async function registerStandalonePanelRuntime(deps: CommonDeps & {
  standaloneSessions: Map<string, import("./standaloneBridge.js").StandaloneSession>;
}): Promise<void> {
  const { container, dispatcher, tokenManager, gitServer, adminToken, args } = deps;
  const { rpcService } = await import("../shared/managedService.js");

  const standaloneSessions = deps.standaloneSessions;

  // Bridge RPC service (standalone mode — uses session map, not PanelLifecycle)
  {
    const { handleStandaloneBridgeCall, createStandalonePanelManager } = await import("./standaloneBridge.js");
    const { BRIDGE_METHOD_SCHEMAS } = await import("../shared/bridgeMethodSchemas.js");
    let standalonePm: import("../shared/panelInterfaces.js").BridgePanelManager;
    let bridgeDeps: import("./standaloneBridge.js").StandaloneBridgeDeps;
    container.register({
      name: "bridge",
      dependencies: ["fsService", "rpcServer"],
      optionalDependencies: ["panelServing"],
      async start(resolve) {
        const fsServiceInst = resolve<import("../shared/fsService.js").FsService>("fsService")!;
        const { server: rpcSrv } = resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")!;
        const panelServingResult = resolve<{ cdpBridge: import("./cdpBridge.js").CdpBridge }>("panelServing", true);
        const cdpBridge = panelServingResult?.cdpBridge ?? null;
        const wkrdPort = resolve<import("./workerdManager.js").WorkerdManager>("workerdManager")?.getPort() ?? 0;

        // rpcPort/gatewayPort use live getters — they return 0 at registration time
        // but the correct gateway port after gateway.start() calls rpcServer.setPort()
        bridgeDeps = {
          sessions: standaloneSessions,
          tokenManager,
          fsService: fsServiceInst,
          gitServer,
          cdpBridge,
          get rpcPort() { return rpcSrv.getPort() ?? 0; },
          workerdPort: wkrdPort,
          protocol: deps.hostConfig.protocol,
          externalHost: deps.hostConfig.externalHost,
          get gatewayPort() { return rpcSrv.getPort() ?? 0; },
          emitEvent: deps.eventService
            ? (event, payload) => deps.eventService!.emit(event as import("../shared/events.js").EventName, payload as any)
            : undefined,
        };
        standalonePm = createStandalonePanelManager(bridgeDeps);
      },
      getServiceDefinition() {
        return {
          name: "bridge",
          description: "Panel lifecycle (standalone mode)",
          policy: { allowed: ["panel", "shell", "server"] },
          methods: BRIDGE_METHOD_SCHEMAS,
          handler: async (ctx, method, serviceArgs) => {
            return handleStandaloneBridgeCall(bridgeDeps, standalonePm, ctx.callerId, method, serviceArgs as unknown[]);
          },
        };
      },
    });
  }

  // CDP bridge + browser service (when --serve-panels)
  if (args.servePanels) {
    let panelServingCdpBridge: import("./cdpBridge.js").CdpBridge;
    container.register({
      name: "panelServing",
      dependencies: ["panelHttpServer", "panelHttpWiring", "buildSystem", "rpcServer"],
      async start(resolve) {
        const { server: panelHttpServer, port: panelHttpPort } = resolve<{ server: import("./panelHttpServer.js").PanelHttpServer; port: number }>("panelHttpServer")!;
        const buildSystem = resolve<import("./buildV2/index.js").BuildSystemV2>("buildSystem")!;
        const { server: rpcServer } = resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")!;
        const getLiveRpcPort = () => rpcServer.getPort() ?? 0;

        // Standalone override: use panel service for creation + track sessions for listing/auth
        const standaloneOnDemandInFlight = new Map<string, Promise<any>>();
        panelHttpServer.setCallbacks({
          onDemandCreate: async (source, subdomain) => {
            for (const session of standaloneSessions.values()) {
              if (session.source === source && session.subdomain === subdomain) {
                const rpcToken = tokenManager.ensureToken(session.panelId, "panel");
                return { panelId: session.panelId, rpcPort: getLiveRpcPort(), rpcToken };
              }
            }
            const inflight = standaloneOnDemandInFlight.get(subdomain);
            if (inflight) return inflight;
            const promise = (async () => {
              const serverCtx = { callerId: "server:panelHttp", callerKind: "server" as const };
              const result = await dispatcher.dispatch(
                serverCtx, "panel", "create",
                [source, { contextId: subdomain, isRoot: true, addAsRoot: true }],
              ) as import("../shared/panelFactory.js").PanelCreateResult;

              const { contextIdToSubdomain } = await import("../shared/panelIdUtils.js");
              standaloneSessions.set(result.panelId, {
                panelId: result.panelId,
                source,
                subdomain: contextIdToSubdomain(subdomain),
                contextId: subdomain,
                stateArgs: {},
                parentId: null,
              });

              return {
                panelId: result.panelId,
                rpcPort: getLiveRpcPort(),
                rpcToken: result.rpcToken,
              };
            })();
            standaloneOnDemandInFlight.set(subdomain, promise);
            try { return await promise; } finally { standaloneOnDemandInFlight.delete(subdomain); }
          },
          listPanels: () => [...standaloneSessions.values()].map(s => ({
            panelId: s.panelId, title: s.source, subdomain: s.subdomain,
            source: s.source, parentId: s.parentId, contextId: s.contextId,
          })),
          getBuild: (source, ref) => buildSystem.getBuild(source, ref),
        });

        // CDP bridge — uses session map for auth
        const { CdpBridge } = await import("./cdpBridge.js");
        const cdpBridge = new CdpBridge({
          tokenManager,
          adminToken,
          canAccessBrowser: (requestingPanelId, browserId) => {
            const browserSession = standaloneSessions.get(browserId);
            return browserSession?.parentId === requestingPanelId ||
              standaloneSessions.get(requestingPanelId)?.parentId === browserId;
          },
          panelOwnsBrowser: (requestingPanelId, browserId) => {
            const browserSession = standaloneSessions.get(browserId);
            return browserSession?.parentId === requestingPanelId;
          },
          isPanelKnown: (browserId) => standaloneSessions.has(browserId),
          port: panelHttpPort,
        });
        panelHttpServer.setCdpBridge(cdpBridge);
        panelServingCdpBridge = cdpBridge;

        return { cdpBridge };
      },
      async stop(instance: { cdpBridge: { stop(): Promise<void> } } | undefined) {
        await instance?.cdpBridge?.stop();
      },
      getServiceDefinition() {
        return {
          name: "browser",
          description: "CDP/browser automation (standalone mode)",
          policy: { allowed: ["shell", "panel", "server"] },
          methods: {
            getCdpEndpoint: { args: z.tuple([z.string()]) },
            navigate: { args: z.tuple([z.string(), z.string()]) },
            goBack: { args: z.tuple([z.string()]) },
            goForward: { args: z.tuple([z.string()]) },
            reload: { args: z.tuple([z.string()]) },
            stop: { args: z.tuple([z.string()]) },
          },
          handler: async (ctx, method, serviceArgs) => {
            const a = serviceArgs as unknown[];
            switch (method) {
              case "getCdpEndpoint": {
                const endpoint = panelServingCdpBridge.getCdpEndpoint(a[0] as string, ctx.callerId);
                if (!endpoint) throw new Error(`Access denied or browser not found: ${a[0]}`);
                return endpoint;
              }
              case "navigate": case "goBack": case "goForward": case "reload": case "stop":
                return panelServingCdpBridge.sendBrowserCommand(a[0] as string, ctx.callerId, method, a.slice(1));
              default: throw new Error(`Unknown browser method: ${method}`);
            }
          },
        };
      },
    });
  } else {
    // Stub browser service when --serve-panels is off
    container.register({
      name: "browserStub",
      getServiceDefinition() {
        return {
          name: "browser",
          description: "CDP/browser automation (standalone mode - unavailable)",
          policy: { allowed: ["shell", "panel", "server"] },
          methods: {},
          handler: async () => { throw new Error("browser service requires --serve-panels mode"); },
        };
      },
    });
  }

  // Wire disconnect handler for standalone mode
  container.register({
    name: "standaloneDisconnect",
    dependencies: ["rpcServer", "fsService"],
    optionalDependencies: ["harnessManager"],
    async start(resolve) {
      const { server: rpcServerInst } = resolve<{ server: import("./rpcServer.js").RpcServer }>("rpcServer")!;
      const fsServiceInst = resolve<import("../shared/fsService.js").FsService>("fsService")!;
      const harnessManagerInst = resolve<import("./harnessManager.js").HarnessManager>("harnessManager", true);

      rpcServerInst.setOnClientDisconnect((callerId, callerKind) => {
        const handleKey = callerKind === "panel" || callerKind === "worker" ? callerId : `server:${callerId}`;
        fsServiceInst.closeHandlesForCaller(handleKey);
        if (callerKind === "panel") {
          const session = standaloneSessions.get(callerId);
          if (session) {
            tokenManager.revokeToken(callerId);
            fsServiceInst.unregisterPanelContext(callerId);
            standaloneSessions.delete(callerId);
          }
        } else if (callerKind === "harness") {
          harnessManagerInst?.notifyDisconnected(callerId);
        }
      });
    },
  });
}
