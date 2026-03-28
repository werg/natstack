import { HeadlessSession } from "@workspace/agentic-session";
import { createPanelSandboxConfig } from "@workspace/agentic-core";
import type { ConnectionConfig } from "@workspace/agentic-core";
import { rpc, db } from "@workspace/runtime";

// The panel's rpc has the full interface (call, onEvent, selfId) that
// ConnectionConfig.rpc needs. Cast through the specific interface type.
const rpcConfig = rpc as unknown as NonNullable<ConnectionConfig["rpc"]>;

export class HeadlessRunner {
  private contextId: string;

  constructor(contextId: string) {
    this.contextId = contextId;
  }

  async spawn(opts?: {
    systemPrompt?: string;
    timeout?: number;
    source?: string;
    className?: string;
  }): Promise<HeadlessSession> {
    return HeadlessSession.createWithAgent({
      config: {
        serverUrl: "",
        token: "",
        clientId: `test-${crypto.randomUUID().slice(0, 8)}`,
        rpc: rpcConfig,
      },
      sandbox: createPanelSandboxConfig(rpcConfig, db),
      rpcCall: (t: string, m: string, ...a: unknown[]) => rpcConfig.call(t, m, ...a),
      source: opts?.source ?? "agent-worker",
      className: opts?.className ?? "AiChatWorker",
      contextId: this.contextId,
      systemPrompt: opts?.systemPrompt,
    });
  }
}
