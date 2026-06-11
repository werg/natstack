import { createRpcClient, defineContract } from "./client.js";
import { createInProcessNetwork, inProcessTransport } from "./transports/inProcess.js";

describe("createRpcClient", () => {
  it("does local dispatch without using the transport", async () => {
    const network = createInProcessNetwork();
    const transport = inProcessTransport("self", network);
    const send = vi.spyOn(transport, "send");
    const rpc = createRpcClient({ selfId: "self", callerKind: "worker", transport });

    rpc.expose("add", (req) => {
      const [a, b] = req.args as [number, number];
      expect(req.caller).toEqual({ callerId: "self", callerKind: "worker" });
      expect(req.origin).toEqual({ callerId: "self", callerKind: "worker" });
      return a + b;
    });

    await expect(rpc.call("self", "add", [2, 5])).resolves.toBe(7);
    expect(send).not.toHaveBeenCalled();
  });

  it("passes caller, origin, args, and provenance-scoped req.rpc through a chain", async () => {
    const network = createInProcessNetwork();
    const panel = createRpcClient({
      selfId: "panel:1",
      callerKind: "panel",
      transport: inProcessTransport("panel:1", network),
    });
    const worker = createRpcClient({
      selfId: "worker:1",
      callerKind: "worker",
      transport: inProcessTransport("worker:1", network),
    });
    const durableObject = createRpcClient({
      selfId: "do:notes:Bucket:key",
      callerKind: "do",
      transport: inProcessTransport("do:notes:Bucket:key", network),
    });

    let seenWorkerCaller: unknown;
    let seenDoCaller: unknown;
    let seenDoOrigin: unknown;

    durableObject.expose("save", (req) => {
      seenDoCaller = req.caller;
      seenDoOrigin = req.origin;
      return req.args[0];
    });

    worker.expose("forward", async (req) => {
      seenWorkerCaller = req.caller;
      return req.rpc.call("do:notes:Bucket:key", "save", req.args);
    });

    await expect(panel.call("worker:1", "forward", [{ ok: true }])).resolves.toEqual({ ok: true });
    expect(seenWorkerCaller).toEqual({ callerId: "panel:1", callerKind: "panel" });
    expect(seenDoCaller).toEqual({ callerId: "worker:1", callerKind: "worker" });
    expect(seenDoOrigin).toEqual({ callerId: "panel:1", callerKind: "panel" });
  });

  it("scopes peer.on to events from that peer", async () => {
    const network = createInProcessNetwork();
    const a = createRpcClient({ selfId: "a", callerKind: "panel", transport: inProcessTransport("a", network) });
    const b = createRpcClient({ selfId: "b", callerKind: "worker", transport: inProcessTransport("b", network) });
    const c = createRpcClient({ selfId: "c", callerKind: "worker", transport: inProcessTransport("c", network) });
    const listener = vi.fn();

    a.peer("b").on("ready", listener);
    await c.emit("a", "ready", { from: "c" });
    await b.emit("a", "ready", { from: "b" });

    await vi.waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
    expect(listener.mock.calls[0]?.[0].payload).toEqual({ from: "b" });
  });

  it("supports typed peer call proxy and withContract at runtime", async () => {
    const network = createInProcessNetwork();
    const a = createRpcClient({ selfId: "a", callerKind: "panel", transport: inProcessTransport("a", network) });
    const b = createRpcClient({ selfId: "b", callerKind: "worker", transport: inProcessTransport("b", network) });
    const contract = defineContract({
      caller: {
        methods: {} as {
          sum(a: number, b: number): number;
        },
        events: {} as { done: { ok: boolean } },
        emits: {} as { start: { id: string } },
      },
    });

    b.expose("sum", (req) => {
      const [x, y] = req.args as [number, number];
      return x + y;
    });

    const peer = a.peer("b").withContract(contract, "caller");
    await expect(peer.call.sum(10, 32)).resolves.toBe(42);
  });

  it("generates request ids when crypto.randomUUID is unavailable", async () => {
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
    try {
      const network = createInProcessNetwork();
      const a = createRpcClient({ selfId: "a", transport: inProcessTransport("a", network) });
      const b = createRpcClient({ selfId: "b", transport: inProcessTransport("b", network) });

      b.expose("ping", () => "pong");

      await expect(a.call("b", "ping", [])).resolves.toBe("pong");
    } finally {
      if (cryptoDescriptor) {
        Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, "crypto");
      }
    }
  });

  it("round-trips streaming responses", async () => {
    const network = createInProcessNetwork();
    const a = createRpcClient({ selfId: "a", transport: inProcessTransport("a", network) });
    const b = createRpcClient({ selfId: "b", transport: inProcessTransport("b", network) });

    b.exposeStreaming("download", async (_req, sink) => {
      await sink({
        kind: "head",
        status: 200,
        statusText: "OK",
        headerPairs: [["content-type", "text/plain"]],
        finalUrl: "https://example.test/file",
      });
      await sink({ kind: "chunk", bytes: new TextEncoder().encode("hello") });
      await sink({ kind: "end", bytesIn: 5 });
    });

    const response = await a.stream("b", "download", []);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/plain");
    await expect(response.text()).resolves.toBe("hello");
  });
});
