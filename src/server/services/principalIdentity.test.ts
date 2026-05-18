import { describe, expect, it } from "vitest";
import { PrincipalRegistry } from "@natstack/shared/principalRegistry";

import { resolveCodeIdentity } from "./principalIdentity.js";

describe("resolveCodeIdentity", () => {
  it("resolves concrete DO caller identities through their registered service principal", () => {
    const registry = new PrincipalRegistry();
    registry.register({
      id: "do-service:workers/agent-worker:AiChatWorker",
      kind: "do-service",
      source: {
        repoPath: "workers/agent-worker",
        effectiveVersion: "hash-1",
      },
    });

    expect(
      resolveCodeIdentity(registry, "do:workers/agent-worker:AiChatWorker:ai-chat-96322794")
    ).toEqual({
      callerId: "do:workers/agent-worker:AiChatWorker:ai-chat-96322794",
      callerKind: "worker",
      repoPath: "workers/agent-worker",
      effectiveVersion: "hash-1",
    });
  });

  it("does not resolve concrete DO callers without a registered service principal", () => {
    const registry = new PrincipalRegistry();

    expect(
      resolveCodeIdentity(registry, "do:workers/agent-worker:AiChatWorker:ai-chat-96322794")
    ).toBeNull();
  });
});
