import { HeadlessSession } from "@workspace/agentic-session";
import { createPanelSandboxConfig } from "@workspace/agentic-core";
import type { ConnectionConfig } from "@workspace/agentic-core";
import { gad, rpc } from "@workspace/runtime";

// The panel's rpc has the full interface (call, onEvent, selfId) that
// ConnectionConfig.rpc needs. Cast through the specific interface type.
const rpcConfig = rpc as unknown as NonNullable<ConnectionConfig["rpc"]>;

export const SYSTEM_TEST_AGENT_PROMPT = `You are running inside an automated NatStack system test.

Your job is to exercise the harness and runtime honestly, not to make the test pass by inventing workarounds.

When the task requires a specialized workflow, choose and use the relevant workspace skills yourself. Do not wait for the prompt to name the exact skill or API.

If you cannot quickly find the relevant knowledge needed to accomplish the task, do not try harder by spelunking through unrelated code or guessing APIs. It is desirable, high-signal feedback to say that the docs/skills were insufficient and that you do not know the correct supported path.

If setup, documentation, tools, runtime APIs, or the harness behave incorrectly, stop that line of work and report the mismatch clearly. Do not silently switch to shell commands, raw internal APIs, or unrelated alternate paths unless the task explicitly asks for that fallback.

Use file-loaded eval for substantive multi-line or multi-file eval work. Do not create or edit helper files merely to work around a short documented suite-orchestration eval snippet. If an operation fails, report the error you actually observed, verbatim, with the operation that produced it.

Keep evidence bounded. Report summaries, counts, ids, byte lengths, exact error messages, the final agent message, the validation reason, and the relevant tool call statuses/errors. Do not paste large raw payloads, full database rows, full channel envelopes, image data, or secrets.

Every final response should be concise, include the requested marker tokens exactly when applicable, and mention any problems encountered while setting up or running the test. Never just refer to files or artifacts; describe what the evidence shows and include the concrete mismatch/error in the response.`;

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
   * Per-test prompt overrides can be passed through spawn extraConfig as
   * `systemPrompt` and `systemPromptMode`.
   */
  async spawn(opts?: {
    source?: string;
    className?: string;
  }): Promise<HeadlessSession> {
    return HeadlessSession.createWithAgent({
      config: {
        clientId: rpcConfig.selfId,
        rpc: rpcConfig,
      },
      sandbox: createPanelSandboxConfig(rpcConfig),
      rpcCall: (t: string, m: string, args: unknown[]) => rpcConfig.call(t, m, args),
      source: opts?.source ?? "workers/agent-worker",
      className: opts?.className ?? "AiChatWorker",
      contextId: this.contextId,
      extraConfig: {
        systemPrompt: SYSTEM_TEST_AGENT_PROMPT,
        systemPromptMode: "append",
      },
    });
  }

  async collectDiagnostics(opts?: {
    channelId?: string | null;
    branchId?: string | null;
    error?: unknown;
  }): Promise<Record<string, unknown>> {
    const channelId = opts?.channelId ?? null;
    const diagnostics: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      contextId: this.contextId,
      channelId,
      error: opts?.error instanceof Error ? opts.error.message : opts?.error ? String(opts.error) : null,
    };
    try {
      diagnostics["buildProvenance"] = await rpc.call("main", "build.inspectBuildProvenance", [
        "@workspace-skills/system-testing",
      ]);
    } catch (err) {
      diagnostics["buildProvenanceError"] = err instanceof Error ? err.message : String(err);
    }
    if (channelId) {
      try {
        diagnostics["agentHealth"] = await gad.inspectAgentHealth({
          channelId,
          branchId: opts?.branchId,
          limit: 50,
          envelopeLimit: 25,
          storageLimit: 25,
        });
      } catch (err) {
        diagnostics["agentHealthError"] = err instanceof Error ? err.message : String(err);
      }
    }
    return diagnostics;
  }
}
