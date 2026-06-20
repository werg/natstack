import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStore } from "./store";
import { initialState } from "./state";
import { SessionController } from "./sessionController";

const pubsubMocks = vi.hoisted(() => {
  const client = {
    ready: vi.fn(async () => undefined),
    onRoster: vi.fn(() => () => {}),
    events: vi.fn(async function* () {}),
    close: vi.fn(),
    roster: {},
  };
  return {
    client,
    connectViaRpc: vi.fn(() => client),
  };
});

const bootstrapMocks = vi.hoisted(() => ({
  createAndSubscribeAgent: vi.fn(async () => undefined),
  getChannelDOParticipants: vi.fn(async () => []),
  listAvailableAgents: vi.fn(async () => []),
  newAgentKey: vi.fn((handle: string) => `agent:${handle}`),
  newChannelName: vi.fn(() => "new-channel"),
  unsubscribeDOFromChannel: vi.fn(),
}));

vi.mock("@workspace/pubsub", () => ({
  connectViaRpc: pubsubMocks.connectViaRpc,
}));

vi.mock("@workspace/runtime", () => ({
  rpc: {},
  panel: {
    slotId: "panel:slot-test",
    stateArgs: { set: vi.fn() },
  },
}));
vi.mock("@workspace/runtime/internal/diagnostics", () => ({
  recoveryCoordinator: {},
}));

vi.mock("../messages/register", () => ({
  registerSpectroliteMessageTypes: vi.fn(async () => undefined),
}));

vi.mock("../bootstrap", () => ({
  createAndSubscribeAgent: bootstrapMocks.createAndSubscribeAgent,
  getChannelDOParticipants: bootstrapMocks.getChannelDOParticipants,
  listAvailableAgents: bootstrapMocks.listAvailableAgents,
  newAgentKey: bootstrapMocks.newAgentKey,
  newChannelName: bootstrapMocks.newChannelName,
  unsubscribeDOFromChannel: bootstrapMocks.unsubscribeDOFromChannel,
}));

describe("SessionController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bootstrapMocks.getChannelDOParticipants.mockResolvedValue([]);
    bootstrapMocks.createAndSubscribeAgent.mockResolvedValue(undefined);
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("rehydrates persisted agents after selecting a vault from the picker", async () => {
    const store = createStore(initialState({
      contextId: "ctx",
      channelName: "chan",
      repoRoot: null,
      openPath: null,
      installedAgents: [{
        agentId: "SilentAgentWorker",
        handle: "scribe",
        key: "agent:scribe",
        source: "workers/silent-agent-worker",
        className: "SilentAgentWorker",
      }],
    }));
    const session = new SessionController(store);

    await session.start();
    expect(pubsubMocks.connectViaRpc).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "panel:slot-test",
    }));
    expect(bootstrapMocks.createAndSubscribeAgent).not.toHaveBeenCalled();

    store.setState({ repoRoot: "/projects/default" });
    session.onVaultSelected("/projects/default");
    await vi.waitFor(() => {
      expect(bootstrapMocks.createAndSubscribeAgent).toHaveBeenCalledTimes(1);
    });
    expect(bootstrapMocks.createAndSubscribeAgent).toHaveBeenCalledWith(expect.objectContaining({
      key: "agent:scribe",
      channelId: "chan",
      channelContextId: "ctx",
      replay: true,
    }));
  });

  it("retries failed rehydration with backoff", async () => {
    vi.useFakeTimers();
    const store = createStore(initialState({
      contextId: "ctx",
      channelName: "chan",
      repoRoot: "/projects/default",
      openPath: null,
      installedAgents: [{
        agentId: "SilentAgentWorker",
        handle: "scribe",
        key: "agent:scribe",
        source: "workers/silent-agent-worker",
        className: "SilentAgentWorker",
      }],
    }));
    bootstrapMocks.createAndSubscribeAgent
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce(undefined);
    const session = new SessionController(store);

    await session.start();
    expect(bootstrapMocks.createAndSubscribeAgent).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => {
      expect(bootstrapMocks.createAndSubscribeAgent).toHaveBeenCalledTimes(2);
    });
  });
});
