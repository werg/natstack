import { HeadlessSession } from "@workspace/agentic-session";
import { createPanelSandboxConfig } from "@workspace/agentic-core";
import type { ConnectionConfig } from "@workspace/agentic-core";
import { rpc, db, id as panelId } from "@workspace/runtime";

// The panel's rpc has the full interface (call, onEvent, selfId) that
// ConnectionConfig.rpc needs. Cast through the specific interface type.
const rpcConfig = rpc as unknown as NonNullable<ConnectionConfig["rpc"]>;

export class HeadlessRunner {
  private contextId: string;

  constructor(contextId: string) {
    this.contextId = contextId;
  }

  /**
   * Spawn a headless session bound to this panel.
   *
   * The test agent's eval executes in the panel context with full access to
   * @workspace/runtime, panel APIs, browser panels, etc. The agent uses the
   * standard NatStack chat prompt and tool surface — UI tools like inline_ui
   * and feedback_form will be available because the panel is connected.
   *
   * Per-test prompt overrides should be written into
   * `<contextFolder>/.pi/AGENTS.md` *before* calling spawn().
   */
  async spawn(opts?: {
    source?: string;
    className?: string;
  }): Promise<HeadlessSession> {
    return HeadlessSession.createWithAgent({
      config: {
        serverUrl: "",
        token: "",
        // Use the panel's bare ID (not rpc.selfId which has "panel:" prefix).
        // PubSub events are routed by the RPC bridge using this ID.
        clientId: panelId,
        rpc: rpcConfig,
      },
      sandbox: createPanelSandboxConfig(rpcConfig, db),
      rpcCall: (t: string, m: string, ...a: unknown[]) => rpcConfig.call(t, m, ...a),
      source: opts?.source ?? "workers/agent-worker",
      className: opts?.className ?? "AiChatWorker",
      contextId: this.contextId,
    });
  }
}
