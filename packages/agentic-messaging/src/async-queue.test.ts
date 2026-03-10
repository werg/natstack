import { AsyncQueue, createFanout } from "./async-queue.js";

describe("AsyncQueue", () => {
  it("push/consume maintains FIFO order", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.push(3);
    queue.close();

    const results: number[] = [];
    for await (const value of queue) {
      results.push(value);
    }

    expect(results).toEqual([1, 2, 3]);
  });

  it("push delivers immediately to waiting consumer", async () => {
    const queue = new AsyncQueue<string>();

    // Start consuming - will wait for values
    const consumePromise = (async () => {
      const results: string[] = [];
      for await (const value of queue) {
        results.push(value);
        if (results.length === 2) break;
      }
      return results;
    })();

    // Push values after consumer is already waiting
    queue.push("a");
    queue.push("b");

    const results = await consumePromise;
    expect(results).toEqual(["a", "b"]);
  });

  it("close ends iteration", async () => {
    const queue = new AsyncQueue<string>();
    queue.push("x");

    const consumePromise = (async () => {
      const results: string[] = [];
      for await (const value of queue) {
        results.push(value);
      }
      return results;
    })();

    queue.close();

    const results = await consumePromise;
    expect(results).toEqual(["x"]);
  });

  it("close with error causes throw during iteration", async () => {
    const queue = new AsyncQueue<string>();

    const consumePromise = (async () => {
      const results: string[] = [];
      for await (const value of queue) {
        results.push(value);
      }
      return results;
    })();

    queue.close(new Error("queue error"));

    await expect(consumePromise).rejects.toThrow("queue error");
  });

  it("push after close is ignored", async () => {
    const queue = new AsyncQueue<number>();
    queue.push(1);
    queue.close();
    queue.push(2); // should be ignored

    const results: number[] = [];
    for await (const value of queue) {
      results.push(value);
    }

    expect(results).toEqual([1]);
  });

  it("isClosed and length properties work correctly", () => {
    const queue = new AsyncQueue<number>();

    expect(queue.isClosed).toBe(false);
    expect(queue.length).toBe(0);

    queue.push(1);
    queue.push(2);
    expect(queue.length).toBe(2);

    queue.close();
    expect(queue.isClosed).toBe(true);
  });
});

describe("createFanout", () => {
  it("emit delivers to multiple subscribers", async () => {
    const fanout = createFanout<string>();

    const sub1 = fanout.subscribe();
    const sub2 = fanout.subscribe();

    fanout.emit("hello");
    fanout.close();

    const r1 = await sub1.next();
    expect(r1.value).toBe("hello");

    const r2 = await sub2.next();
    expect(r2.value).toBe("hello");
  });

  it("subscriber cleanup on break decreases subscriberCount", async () => {
    const fanout = createFanout<string>();

    expect(fanout.subscriberCount).toBe(0);

    const sub1 = fanout.subscribe();
    const sub2 = fanout.subscribe();
    expect(fanout.subscriberCount).toBe(2);

    fanout.emit("msg");

    // Consume one value then break (call return)
    await sub1.next();
    await sub1.return!();

    expect(fanout.subscriberCount).toBe(1);

    // Cleanup sub2 as well
    await sub2.return!();
    expect(fanout.subscriberCount).toBe(0);
  });
});
