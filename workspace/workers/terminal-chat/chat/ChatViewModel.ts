import type { HeadlessSession, ChatMessage } from "@workspace/agentic-session";
import { PROVIDER_CONNECT_PRESETS, toPanelConnectRequest } from "@workspace/model-catalog/providerConnect";

/**
 * Terminal view-model over the shared headless chat core.
 *
 * The transcript, streaming, participants and send/receive protocol all come
 * from `@workspace/agentic-session`'s `HeadlessSession` — the SAME core the chat
 * panel's React hooks (`useAgenticChat`/`useChatCore`) are built on. This is the
 * terminal analog of `useAgenticChat`: thin, because the core does the work.
 *
 * Local "notice" lines (command feedback) are merged into the rendered view so
 * the UI has a single ordered list; the durable transcript is channel-backed
 * (replayed on reattach), so we don't persist it ourselves.
 */
export interface ViewMessage {
  id: string;
  role: "user" | "agent" | "system" | "thinking" | "tool" | "approval";
  sender: string;
  text: string;
  streaming?: boolean;
  error?: string;
}

export interface ChatViewModelDeps {
  session: HeadlessSession;
  rpc: { call<T = unknown>(target: string, method: string, args: unknown[]): Promise<T> };
  contextId?: string;
  /** Current model ref, e.g. "anthropic:claude-..."; updated by /model. */
  modelRef?: string;
}

interface Notice {
  id: string;
  text: string;
}

let noticeCounter = 0;

export class ChatViewModel {
  private readonly listeners = new Set<() => void>();
  private notices: Notice[] = [];
  private unsubscribe: (() => void) | null = null;
  private connecting = true;

  constructor(private readonly deps: ChatViewModelDeps) {
    // Re-render on every channel update (incl. streaming deltas).
    this.unsubscribe = deps.session.onMessage(() => {
      this.connecting = false;
      this.emit();
    });
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void {
    for (const l of [...this.listeners]) {
      try {
        l();
      } catch {
        /* a listener must not break the view-model */
      }
    }
  }

  dispose(): void {
    this.unsubscribe?.();
    this.listeners.clear();
  }

  status(): string {
    if (this.connecting && !this.deps.session.connected) return "connecting";
    return this.deps.session.connected ? "online" : "offline";
  }

  /** The merged, ordered view the Ink transcript renders. */
  view(): ViewMessage[] {
    const out: ViewMessage[] = this.deps.session.messages.map((m) => toViewMessage(m));
    for (const notice of this.notices) {
      out.push({ id: notice.id, role: "system", sender: "·", text: notice.text });
    }
    return out;
  }

  private addNotice(text: string): void {
    this.notices.push({ id: `n${++noticeCounter}`, text });
    this.emit();
  }

  /** Submit a line: run a slash command or send to the agent. */
  async submit(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    if (trimmed.startsWith("/")) {
      await this.runCommand(trimmed.slice(1));
      return;
    }
    try {
      await this.deps.session.send(trimmed);
    } catch (err) {
      this.addNotice(`Send failed: ${errText(err)}`);
    }
  }

  private async runCommand(raw: string): Promise<void> {
    const [cmd, ...rest] = raw.split(/\s+/);
    const arg = rest.join(" ").trim();
    switch ((cmd ?? "").toLowerCase()) {
      case "help":
        this.addNotice(HELP);
        return;
      case "clear":
      case "new":
        this.addNotice("Use Ctrl+N for a fresh session; transcript history is channel-backed.");
        return;
      case "agents":
        await this.listAgents();
        return;
      case "model":
        await this.handleModel(arg);
        return;
      case "connect":
        await this.handleConnect(arg);
        return;
      case "switch":
        this.addNotice("Use Ctrl+P to switch sessions.");
        return;
      case "logs":
        this.addNotice("Use Ctrl+L to view logs.");
        return;
      case "approvals":
        this.addNotice("Use Ctrl+A to view approvals.");
        return;
      default:
        this.addNotice(`Unknown command: /${cmd ?? ""}. Try /help.`);
    }
  }

  private async listAgents(): Promise<void> {
    try {
      const sources = await this.deps.rpc.call<Array<{ name?: string; source?: string }>>(
        "main",
        "workers.listSources",
        [],
      );
      const names = (Array.isArray(sources) ? sources : [])
        .map((s) => s.name ?? s.source)
        .filter(Boolean);
      this.addNotice(names.length ? `Available agents:\n${names.join("\n")}` : "No agent sources found.");
    } catch (err) {
      this.addNotice(`/agents failed: ${errText(err)}`);
    }
  }

  private async handleModel(arg: string): Promise<void> {
    if (!arg) {
      this.addNotice(`Current model: ${this.deps.modelRef ?? "(default)"}.\nUsage: /model <provider:modelId>`);
      return;
    }
    // Setting a model live requires re-subscribing the agent with new config —
    // surfaced as intent; applied on the next session for now.
    this.deps.modelRef = arg;
    this.addNotice(`Model set to ${arg} (applies to new sessions).`);
  }

  private async handleConnect(arg: string): Promise<void> {
    const provider = arg || "anthropic";
    const preset = PROVIDER_CONNECT_PRESETS[provider];
    if (!preset) {
      this.addNotice(
        `Unknown provider "${provider}". Try one of: ${Object.keys(PROVIDER_CONNECT_PRESETS).join(", ")}`,
      );
      return;
    }
    try {
      const request = toPanelConnectRequest(provider, "", { browser: "external" });
      if (!request) {
        this.addNotice(`Could not build a connect request for ${provider}.`);
        return;
      }
      await this.deps.rpc.call("main", "credentials.connect", [request]);
      this.addNotice(`Connect flow started for ${provider}. Follow the prompt to finish.`);
    } catch (err) {
      this.addNotice(`/connect failed: ${errText(err)}`);
    }
  }
}

const HELP = [
  "/help      show commands",
  "/agents    list available agent workers",
  "/model     show/set model (provider:modelId)",
  "/connect   connect a model provider",
  "/new       new session (Ctrl+N)",
  "/switch    switch sessions (Ctrl+P)",
  "/logs      view logs (Ctrl+L)",
  "/approvals view approvals (Ctrl+A)",
].join("\n");

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function toViewMessage(m: ChatMessage): ViewMessage {
  const sender = m.senderMetadata?.handle ?? m.senderMetadata?.name ?? m.senderId;
  const isAgent = m.senderMetadata?.type === "agent" || m.senderMetadata?.type === "headless";

  if (m.approval) {
    return {
      id: m.id,
      role: "approval",
      sender,
      text: `${m.approval.question ?? "Approval requested"} [${m.approval.status}]`,
    };
  }
  if (m.invocation) {
    const x = m.invocation;
    return {
      id: m.id,
      role: "tool",
      sender,
      text: `⚙ ${x.name} [${x.execution.status}]${x.execution.description ? ` — ${x.execution.description}` : ""}`,
      error: x.execution.isError ? "tool error" : undefined,
    };
  }
  if (m.contentType === "thinking") {
    return { id: m.id, role: "thinking", sender, text: m.content, streaming: m.complete === false };
  }
  if (m.kind === "system") {
    return { id: m.id, role: "system", sender: "·", text: m.content };
  }
  return {
    id: m.id,
    role: isAgent ? "agent" : "user",
    sender,
    text: m.content,
    streaming: m.complete === false,
    error: m.error,
  };
}
