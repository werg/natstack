import React from "react";
import { render, Box, Text, type Instance } from "ink";
import { DurableObjectBase } from "@workspace/runtime/worker";
import { HeadlessSession } from "@workspace/agentic-session";
import { createInkTerminalSession, type InkTerminalSession } from "@workspace/terminal-shim";
import {
  HOST_METHODS,
  SESSION_METHODS,
  encodeFrame,
  decodeInputData,
  type StartTerminalSessionArgs,
  type TerminalInputEvent,
  type TerminalResizeEvent,
} from "@workspace/terminal-host-protocol";
import { ChatViewModel } from "./chat/ChatViewModel.js";
import { TerminalChatApp } from "./chat/TerminalChatApp.js";

const HEARTBEAT_MS = 5_000;
const AGENT_SOURCE = "workers/agent-worker";
const AGENT_CLASS = "AiChatWorker";

function Centered({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column" paddingX={1}>
      {children}
    </Box>
  );
}

/**
 * Persistent terminal chat session DO. Renders an Ink chat UI inside workerd and
 * streams it to the trusted terminal-browser host. The chat itself runs on the
 * SHARED headless core (`@workspace/agentic-session` `HeadlessSession`) — the
 * same `ConnectionManager` + channel-view reducer + `ChatMessage` model the chat
 * panel's React hooks use — so the terminal chat is functionally equivalent to
 * the panel (streaming, thinking, tool cards, approvals, model/provider config).
 */
export class TerminalChatWorker extends DurableObjectBase {
  private session: InkTerminalSession | null = null;
  private instance: Instance | null = null;
  private headless: HeadlessSession | null = null;
  private vm: ChatViewModel | null = null;
  private hostPrincipalId = "";
  private sessionId = "";
  private seq = 0;
  private deliver: Promise<unknown> = Promise.resolve();
  private channelName: string | null = null;
  private active = false;

  protected createTables(): void {}

  async [SESSION_METHODS.start](args: StartTerminalSessionArgs): Promise<void> {
    this.ensureReady();
    this.hostPrincipalId = args.hostPrincipalId;
    this.sessionId = args.sessionId;
    this.active = true;
    this.channelName = this.getStateValue("channel") ?? `chat-${args.sessionId}`;
    this.setStateValue("channel", this.channelName);

    this.session = createInkTerminalSession({
      sessionId: args.sessionId,
      sink: {
        write: (stream, bytes) => this.forwardFrame(stream, bytes),
        setRawMode: (enabled) =>
          void this.rpc
            .call(this.hostPrincipalId, HOST_METHODS.setRawMode, [this.sessionId, enabled])
            .catch(() => {}),
      },
      initialSize: args.viewport,
    });

    // Render a connecting placeholder immediately so the host shows something.
    this.instance = this.renderInk(
      <Centered>
        <Text color="green">NatStack Chat</Text>
        <Text dimColor>Connecting to agent…</Text>
      </Centered>,
    );
    this.ctx.waitUntil?.(this.instance.waitUntilExit());
    this.setAlarm(HEARTBEAT_MS);

    try {
      const rpc = this.rpc;
      const modelRef = this.getStateValue("model") ?? undefined;
      this.headless = await HeadlessSession.createWithAgent({
        config: {
          clientId: rpc.selfId,
          rpc: {
            call: <R,>(t: string, m: string, a: unknown[]) => rpc.call<R>(t, m, a),
            on: (event: string, listener: (event: { payload: unknown }) => void) =>
              rpc.on(event, listener),
            selfId: rpc.selfId,
          },
        },
        metadata: { name: "Terminal", type: "panel", handle: "terminal" },
        rpcCall: (t, m, a) => rpc.call(t, m, a),
        source: AGENT_SOURCE,
        className: AGENT_CLASS,
        objectKey: `ai-chat-${args.sessionId}`,
        contextId: args.contextId ?? "",
        channelId: this.channelName,
        ...(modelRef ? { extraConfig: { model: modelRef } } : {}),
      });
      this.vm = new ChatViewModel({
        session: this.headless,
        rpc: { call: (t, m, a) => rpc.call(t, m, a) },
        contextId: args.contextId,
        modelRef,
      });
      this.instance.rerender(this.renderTree());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.instance?.rerender(
        <Centered>
          <Text color="green">NatStack Chat</Text>
          <Text color="red">Could not connect to the agent.</Text>
          <Text dimColor>{message}</Text>
          <Text dimColor>Ctrl+N to retry · Ctrl+A for approvals</Text>
        </Centered>,
      );
    }
  }

  async [SESSION_METHODS.onInput](event: TerminalInputEvent): Promise<void> {
    this.session?.emitInput(decodeInputData(event));
  }
  async [SESSION_METHODS.onResize](event: TerminalResizeEvent): Promise<void> {
    this.session?.emitResize(event.size);
  }
  async [SESSION_METHODS.onFocus](): Promise<void> {}
  async [SESSION_METHODS.onBlur](): Promise<void> {}
  async [SESSION_METHODS.repaint](): Promise<void> {
    if (this.vm) this.instance?.rerender(this.renderTree());
  }
  async [SESSION_METHODS.onClose](): Promise<void> {
    this.active = false;
    this.vm?.dispose();
    this.instance?.unmount();
    this.session?.dispose();
    await this.headless?.close().catch(() => {});
    this.instance = null;
    this.session = null;
    this.headless = null;
    this.vm = null;
  }

  private renderTree(): React.ReactElement {
    if (!this.vm) {
      return (
        <Centered>
          <Text dimColor>Connecting…</Text>
        </Centered>
      );
    }
    return <TerminalChatApp vm={this.vm} />;
  }

  private renderInk(tree: React.ReactElement): Instance {
    const s = this.session!;
    return render(tree, {
      stdin: s.stdin as unknown as NodeJS.ReadStream,
      stdout: s.stdout as unknown as NodeJS.WriteStream,
      stderr: s.stderr as unknown as NodeJS.WriteStream,
      patchConsole: false,
      exitOnCtrlC: false,
    });
  }

  private forwardFrame(stream: "stdout" | "stderr", bytes: Uint8Array): void {
    const frame = encodeFrame(this.sessionId, stream, bytes, this.seq++);
    this.deliver = this.deliver.then(() =>
      this.rpc.call(this.hostPrincipalId, HOST_METHODS.onFrame, [frame]).catch(() => {}),
    );
  }

  async alarm(): Promise<void> {
    if (this.active) this.setAlarm(HEARTBEAT_MS);
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(
      "TerminalChatWorker — a terminal-renderable DO. Launch via the terminal-browser host app.",
      { headers: { "Content-Type": "text/plain" } },
    );
  },
};
