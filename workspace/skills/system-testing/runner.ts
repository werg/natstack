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

  /**
   * Spawn a headless session with full panel capabilities.
   *
   * Since HeadlessRunner runs inside a panel, the test agent's eval
   * executes in the panel context with full access to @workspace/runtime,
   * panel APIs, browser panels, etc. We use `useDefaultPrompt: true`
   * so the agent gets the standard NatStack chat prompt with all tools
   * available — not the restrictive headless prompt.
   */
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
      // Use the default NatStack chat prompt with all tools — don't restrict
      // to eval+set_title since we're running in a panel context with full capabilities.
      useDefaultPrompt: true,
    });
  }
}
