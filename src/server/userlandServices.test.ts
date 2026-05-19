import { describe, expect, it } from "vitest";
import {
  SingletonRegistry,
  type WorkspaceDeclarations,
} from "@natstack/shared/workspace/singletonRegistry";
import { resolveUserlandService } from "./userlandServices.js";

function makeDecls(opts: { withSingleton?: boolean }): WorkspaceDeclarations {
  const singletons = new SingletonRegistry(
    opts.withSingleton
      ? [{ source: "workers/pubsub-channel", className: "PubSubChannel", key: "default" }]
      : []
  );
  return {
    singletons,
    services: [
      {
        source: "workers/pubsub-channel",
        name: "channel",
        protocols: ["natstack.channel.v1"],
        policy: { allowed: ["panel", "shell", "server", "worker", "extension", "harness"] },
        durableObject: { className: "PubSubChannel" },
      },
    ],
    routes: [],
  };
}

describe("resolveUserlandService — factory vs singleton DO services", () => {
  it("returns the singleton key when a singletonObjects row matches and no objectKey is given", () => {
    const decls = makeDecls({ withSingleton: true });
    const resolved = resolveUserlandService(decls, "natstack.channel.v1");
    expect(resolved).toMatchObject({
      kind: "durable-object",
      name: "channel",
      className: "PubSubChannel",
      objectKey: "default",
    });
  });

  it("honours an explicit objectKey override even when a singleton row exists", () => {
    const decls = makeDecls({ withSingleton: true });
    const resolved = resolveUserlandService(decls, "natstack.channel.v1", "chat-1");
    expect(resolved).toMatchObject({
      kind: "durable-object",
      objectKey: "chat-1",
      targetId: "do:workers/pubsub-channel:PubSubChannel:chat-1",
    });
  });

  it("returns the caller-supplied objectKey for a factory service (no singleton row)", () => {
    const decls = makeDecls({ withSingleton: false });
    const resolved = resolveUserlandService(decls, "natstack.channel.v1", "chat-1");
    expect(resolved).toMatchObject({
      kind: "durable-object",
      objectKey: "chat-1",
      targetId: "do:workers/pubsub-channel:PubSubChannel:chat-1",
    });
  });

  it("throws when resolving a factory service without an objectKey", () => {
    const decls = makeDecls({ withSingleton: false });
    expect(() => resolveUserlandService(decls, "natstack.channel.v1")).toThrow(
      /factory.*objectKey/i
    );
  });

  it("throws when resolving a factory service with null/undefined objectKey", () => {
    const decls = makeDecls({ withSingleton: false });
    expect(() => resolveUserlandService(decls, "natstack.channel.v1", null)).toThrow(
      /factory.*objectKey/i
    );
  });
});
