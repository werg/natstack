import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { ParticipantDescriptor } from "@workspace/harness";

import { AiChatWorker } from "./ai-chat-worker.js";
import { GmailAgentWorker } from "../gmail-agent/gmail-agent-worker.js";
import { SilentAgentWorker } from "../silent-agent-worker/index.js";
import { TestAgentWorker } from "../test-agent/test-agent-worker.js";

const STANDARD_METHODS = [
  "pause",
  "resume",
  "credentialConnected",
  "connectModelCredential",
  "setModel",
  "setThinkingLevel",
  "setApprovalLevel",
  "setRespondPolicy",
  "getAgentSettings",
  "getDebugState",
];

class ContractAiChatWorker extends AiChatWorker {
  participant(): ParticipantDescriptor {
    return this.getParticipantInfo("ch-1");
  }
}

class ContractGmailAgentWorker extends GmailAgentWorker {
  participant(): ParticipantDescriptor {
    return this.getParticipantInfo("ch-1");
  }
}

class ContractSilentAgentWorker extends SilentAgentWorker {
  participant(): ParticipantDescriptor {
    return this.getParticipantInfo("ch-1");
  }
}

class ContractTestAgentWorker extends TestAgentWorker {
  participant(): ParticipantDescriptor {
    return this.getParticipantInfo("ch-1");
  }
}

describe("agent worker contracts", () => {
  it.each([
    ["AI chat", async () => (await createTestDO(ContractAiChatWorker)).instance],
    ["Gmail", async () => (await createTestDO(ContractGmailAgentWorker)).instance],
    ["Silent", async () => (await createTestDO(ContractSilentAgentWorker)).instance],
    ["Test", async () => (await createTestDO(ContractTestAgentWorker)).instance],
  ] satisfies Array<[string, () => Promise<{ participant(): ParticipantDescriptor }>]>)(
    "%s exposes the standard agent control methods",
    async (_name, createWorker) => {
      const methodNames = (await createWorker())
        .participant()
        .methods?.map((method) => method.name);

      expect(methodNames).toEqual(expect.arrayContaining(STANDARD_METHODS));
    }
  );
});
