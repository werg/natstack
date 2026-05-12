import { describe, expect, it, vi } from "vitest";
import { ServiceDispatcher, type ServiceContext } from "@natstack/shared/serviceDispatcher";
import { createWorkerService } from "./workerService.js";

const panelCtx: ServiceContext = { callerId: "panel:test", callerKind: "panel" };

function createDeps() {
  const dispatch = vi.fn(async () => [
    {
      participantId: "do:workers/agent-worker:AiChatWorker:agent-1",
      metadata: {},
    },
  ]);
  return {
    doDispatch: { dispatch },
    buildSystem: {
      getGraph: () => ({
        allNodes: () => [
          {
            kind: "worker",
            name: "pubsub-channel",
            relativePath: "workers/pubsub-channel",
            manifest: {
              durable: { classes: [{ className: "PubSubChannel" }] },
              services: [
                {
                  name: "channel",
                  protocols: ["natstack.channel.v1"],
                  durableObject: { className: "PubSubChannel" },
                },
              ],
            },
          },
          {
            kind: "worker",
            name: "stateless-api",
            relativePath: "workers/stateless-api",
            manifest: {
              routes: [{ path: "/api", methods: ["POST"] }],
              services: [
                {
                  name: "stateless-api",
                  protocols: ["example.stateless.v1"],
                  worker: { routePath: "/api" },
                },
              ],
            },
          },
        ],
      }),
    },
    fsService: {
      getCallerContext: vi.fn(() => "ctx-1"),
      registerCallerContext: vi.fn(),
    },
  };
}

describe("workerService userland service resolution", () => {
  it("lists and resolves manifest-declared services", async () => {
    const deps = createDeps();
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(createWorkerService(deps as never));
    dispatcher.markInitialized();

    await expect(dispatcher.dispatch(panelCtx, "workers", "listServices", []))
      .resolves.toEqual([
        expect.objectContaining({
          name: "channel",
          kind: "durable-object",
          protocols: ["natstack.channel.v1"],
          source: "workers/pubsub-channel",
          className: "PubSubChannel",
        }),
        expect.objectContaining({
          name: "stateless-api",
          kind: "worker",
          protocols: ["example.stateless.v1"],
          source: "workers/stateless-api",
          routePath: "/api",
        }),
      ]);

    await expect(dispatcher.dispatch(panelCtx, "workers", "resolveService", ["natstack.channel.v1", "chat-1"]))
      .resolves.toMatchObject({
        kind: "durable-object",
        name: "channel",
        source: "workers/pubsub-channel",
        className: "PubSubChannel",
        objectKey: "chat-1",
        targetId: "do:workers/pubsub-channel:PubSubChannel:chat-1",
      });

    await expect(dispatcher.dispatch(panelCtx, "workers", "resolveService", ["example.stateless.v1"]))
      .resolves.toMatchObject({
        kind: "worker",
        name: "stateless-api",
        source: "workers/stateless-api",
        routePath: "/api",
        routeBasePath: "/_r/w/workers/stateless-api/api",
      });
  });

  it("uses the channel service resolver for channel workers", async () => {
    const deps = createDeps();
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService(createWorkerService(deps as never));
    dispatcher.markInitialized();

    await expect(dispatcher.dispatch(panelCtx, "workers", "getChannelWorkers", ["chat-1"]))
      .resolves.toEqual([
        {
          participantId: "do:workers/agent-worker:AiChatWorker:agent-1",
          source: "workers/agent-worker",
          className: "AiChatWorker",
          objectKey: "agent-1",
          channelId: "chat-1",
        },
      ]);

    expect(deps.doDispatch.dispatch).toHaveBeenCalledWith(
      { source: "workers/pubsub-channel", className: "PubSubChannel", objectKey: "chat-1" },
      "getParticipants",
    );
  });
});
