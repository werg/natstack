import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ChannelEvent, HarnessConfig, HarnessOutput, ParticipantDescriptor } from "@natstack/harness/types";

/**
 * Default system prompt appended to the SDK's built-in prompt for all chat panels.
 *
 * This covers NatStack-specific knowledge: available tools, workspace skills,
 * interaction patterns, and runtime APIs. The SDK's built-in prompt already
 * handles general coding behavior, tool usage patterns, and safety guidelines.
 */
const CHAT_SYSTEM_PROMPT = `You are an AI assistant in a NatStack workspace — a local, AI-powered environment with stackable panels, browser automation, and a code sandbox.

## Tool guidance

- **eval** is your primary tool. Use it for all actions — files, databases, APIs, panels, browsers. Use static imports (not dynamic await import()). \`chat\`, \`scope\`, and \`scopes\` are pre-injected. Import \`contextId\` from \`@workspace/runtime\`. Every eval result includes a \`[scope]\` summary showing current keys.
- Use **inline_ui** for interactive results (tables, dashboards, action buttons). Use **feedback_form** when you need a user choice before continuing.
- Call **set_title** after the first substantive exchange.

## Scope

\`scope\` is a live in-memory object shared across eval calls — store anything (handles, pages, functions, data) and it all works between calls. After every eval, the result includes a \`[scope]\` line listing current keys. Scope is serialized to DB automatically; on panel reload, data survives but functions and class instances are lost. A system message will list what was restored, partially restored, or lost.

## Workspace skills

Load a skill when the conversation enters its domain — don't guess at APIs when a skill has the reference.

- **sandbox** — eval/inline_ui/feedback patterns, runtime API reference (fs, db, git, workers, ai, oauth), browser automation
- **paneldev** — building panels, workers, Durable Objects, RPC contracts, development workflow
- **browser-import** — importing cookies, passwords, bookmarks, history from installed browsers
- **api-integrations** — connecting to OAuth APIs (Gmail, GitHub, Slack, Notion, Linear)
- **onboarding** — first-time setup, workspace configuration, NatStack overview

## Style

Show, don't tell — use eval to demonstrate. Use inline_ui for rich results. Use feedback_form for choices, not text questions.
`;

/**
 * AiChatWorker — The default AI chat Durable Object.
 *
 * Manages one-harness-per-channel AI conversations. All per-turn state
 * (active turns, in-flight turns, checkpoints) is stored in SQLite so
 * that no instance fields need to survive across DO invocations.
 *
 * Key flows:
 *   1. First user message → spawn harness via RPC harness.spawn
 *   2. Subsequent messages → start-turn command via RPC harness.sendCommand
 *   3. Harness events → streamed to channel via StreamWriter (async PubSub RPC)
 *   4. Crash recovery → respawn via RPC harness.spawn
 *   5. Tool approval → async via PubSub callMethod + onCallResult continuation
 *
 * All methods return void — side effects are RPC calls, not action arrays.
 */
export class AiChatWorker extends AgentWorkerBase {
  static override schemaVersion = 3;

  // --- Hook overrides ---

  protected override getHarnessConfig(): HarnessConfig {
    return {
      toolAllowlist: ["eval", "feedback_form", "feedback_custom", "set_title", "inline_ui"],
      systemPrompt: CHAT_SYSTEM_PROMPT,
    };
  }

  protected override getParticipantInfo(
    _channelId: string,
    config?: unknown,
  ): ParticipantDescriptor {
    const cfg = config as Record<string, unknown> | undefined;
    return {
      handle: (cfg?.["handle"] as string) ?? "ai-chat",
      name: "AI Chat",
      type: "agent",
      metadata: {},
      methods: [
        { name: "pause", description: "Pause the current AI turn" },
        { name: "resume", description: "Resume after pause" },
      ],
    };
  }

  // --- Channel events (returns void) ---

  async onChannelEvent(
    channelId: string,
    event: ChannelEvent,
  ): Promise<void> {
    if (!this.shouldProcess(event)) {
      this.advanceCheckpoint(channelId, null, event.id);
      return;
    }

    const input = this.buildTurnInput(event);
    const activeHarnessId = this.getActiveHarness();
    const participantId = this.getParticipantId(channelId);

    // Build typing data with proper display name
    const participantInfo = this.getParticipantInfo(channelId);
    const typingContent = JSON.stringify({
      senderId: event.senderId,
      senderName: participantInfo.name,
      senderType: participantInfo.type,
    });

    if (!activeHarnessId) {
      // No active harness — spawn one with the first turn bundled.
      const contextId = this.getContextId(channelId);
      const config = this.buildHarnessConfig(channelId);
      const harnessId = `harness-${crypto.randomUUID()}`;

      // Resume from the most recent session on this channel (restart recovery)
      const resumeSessionId = this.getResumeSessionIdForChannel(channelId);
      if (resumeSessionId) {
        config.extraEnv = { ...config.extraEnv, RESUME_SESSION_ID: resumeSessionId };
      }

      // Register harness and record turn locally before spawning
      this.registerHarness(harnessId, this.getHarnessType());
      this.recordTurnStart(harnessId, channelId, input, event.messageId, event.id, event.senderId);

      // Send bootstrap typing indicator directly
      const bootstrapTypingId = crypto.randomUUID();
      this.sql.exec(
        `INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)`,
        `bootstrap_typing:${channelId}`, bootstrapTypingId,
      );
      if (participantId) {
        const channel = this.createChannelClient(channelId);
        await channel.send(participantId, bootstrapTypingId, typingContent, {
          contentType: "typing",
          persist: true,
          replyTo: event.messageId,
        });
        this.adoptBootstrapTyping(harnessId, channelId);
      }

      // Spawn harness via server API
      await this.rpc.call("main", "harness.spawn", {
        doRef: this.doRef,
        harnessId,
        type: this.getHarnessType(),
        contextId,
        config,
        initialInput: input,
      });
    } else if (this.getActiveTurn(activeHarnessId)) {
      // Turn in progress — send to harness first, only enqueue on success
      await this.rpc.call("main", "harness.sendCommand", activeHarnessId, {
        type: "start-turn",
        input,
      });
      this.enqueueTurn(channelId, activeHarnessId, event.messageId, event.id, event.senderId, input, typingContent);
      this.advanceCheckpoint(channelId, activeHarnessId, event.id);
    } else {
      // Harness idle — start a new turn immediately
      this.setActiveTurn(activeHarnessId, channelId, event.messageId, undefined, event.senderId, typingContent);

      // Start typing via StreamWriter
      const newTurn = this.getActiveTurn(activeHarnessId)!;
      const turnWriter = this.createWriter(channelId, newTurn);
      await turnWriter.startTyping();
      this.persistStreamState(activeHarnessId, turnWriter);

      this.setInFlightTurn(channelId, activeHarnessId, event.messageId, event.id, input);
      this.advanceCheckpoint(channelId, activeHarnessId, event.id);

      // Send start-turn command to harness
      await this.rpc.call("main", "harness.sendCommand", activeHarnessId, {
        type: "start-turn",
        input,
      });
    }
  }

  // --- Harness events (returns void) ---

  async onHarnessEvent(
    harnessId: string,
    event: HarnessOutput,
  ): Promise<void> {
    const turn = this.getActiveTurn(harnessId);
    const channelId = turn?.channelId;

    // Ready event doesn't need a channel — just update status
    if (event.type === "ready") {
      this.sql.exec(
        `UPDATE harnesses SET status = 'active' WHERE id = ?`,
        harnessId,
      );
      return;
    }

    if (!channelId) return;

    // Create a StreamWriter for events that produce channel output
    const writer = turn ? this.createWriter(channelId, turn) : null;
    if (writer && event.type !== "turn-complete" && event.type !== "error") {
      await writer.startTyping();
    }

    switch (event.type) {
      // --- Thinking lifecycle ---
      case "thinking-start":
        await writer?.startThinking();
        break;

      case "thinking-delta":
        await writer?.updateThinking(event.content);
        break;

      case "thinking-end":
        await writer?.endThinking();
        break;

      // --- Text streaming ---
      case "text-start":
        await writer?.startText(event.metadata);
        break;

      case "text-delta":
        await writer?.updateText(event.content);
        break;

      case "text-end":
        await writer?.completeText();
        break;

      // --- Tool actions ---
      case "action-start":
        await writer?.startAction(event.tool, event.description, event.toolUseId);
        break;

      case "action-end":
        await writer?.endAction();
        break;

      // --- Inline UI ---
      case "inline-ui":
        await writer?.sendInlineUi(event.data);
        break;

      // --- Message / turn completion ---
      case "message-complete":
        break;

      case "turn-complete": {
        console.log(`[AiChatWorker] Turn complete: harnessId=${harnessId}, sessionId=${event.sessionId}, channelId=${channelId}`);
        if (writer) {
          await writer.stopTyping();
          await writer.endThinking();
          await writer.endAction();
          await writer.completeText();
          this.persistStreamState(harnessId, writer);
        }
        await this.cleanupBootstrapTyping(channelId);

        const activeTurn = this.getActiveTurn(harnessId);
        if (activeTurn?.turnMessageId) {
          const inFlight = this.getInFlightTurn(channelId, harnessId);
          this.recordTurn(
            harnessId,
            activeTurn.turnMessageId,
            inFlight?.triggerPubsubId ?? 0,
            event.sessionId,
          );
        }
        this.clearActiveTurn(harnessId);
        this.clearInFlightTurn(channelId, harnessId);

        // Dequeue next turn if any — harness already auto-dequeued on its side
        const next = this.dequeueNextTurn(harnessId);
        if (next) {
          const nextParticipantInfo = this.getParticipantInfo(next.channelId);
          const nextTypingContent = next.typingContent || JSON.stringify({
            senderId: next.senderId,
            senderName: nextParticipantInfo.name,
            senderType: nextParticipantInfo.type,
          });
          this.setActiveTurn(harnessId, next.channelId, next.messageId, undefined, next.senderId, nextTypingContent);

          const nextTurn = this.getActiveTurn(harnessId)!;
          const nextWriter = this.createWriter(next.channelId, nextTurn);
          await nextWriter.startTyping();
          this.persistStreamState(harnessId, nextWriter);

          this.setInFlightTurn(next.channelId, harnessId, next.messageId, next.pubsubId, next.turnInput);
        }
        break;
      }

      // --- Error handling ---
      case "error":
        if (event.code) {
          // Turn-level error — complete partial output, send error message
          if (writer) {
            await writer.stopTyping();
            await writer.endThinking();
            await writer.endAction();
            await writer.completeText();
            this.persistStreamState(harnessId, writer);
          }
          await this.cleanupBootstrapTyping(channelId);
          const participantId = this.getParticipantId(channelId);
          if (participantId) {
            const errorChannel = this.createChannelClient(channelId);
            await errorChannel.send(
              participantId, crypto.randomUUID(),
              JSON.stringify({ error: event.error, code: event.code }),
              { contentType: "error", persist: true, replyTo: turn?.replyToId },
            );
          }
        } else {
          // Process-level crash — full crash recovery
          await this.handleHarnessCrash(harnessId, channelId, event.error);
        }
        break;

      // --- Approval (async via PubSub callMethod + continuation) ---
      case "approval-needed": {
        // Check if channel's approval level allows auto-approval
        if (this.shouldAutoApprove(channelId, event.toolName)) {
          await this.rpc.call("main", "harness.sendCommand", harnessId, {
            type: "approve-tool",
            toolUseId: event.toolUseId,
            allow: true,
          });
          // Clear continuation flag — harness will resume immediately
          this.turns.setPendingContinuation(harnessId, false);
          break;
        }

        // Needs user input — route to panel
        const callId = crypto.randomUUID();
        const activeTurnForApproval = this.getActiveTurn(harnessId);
        const panelId = activeTurnForApproval?.senderParticipantId;
        if (!panelId) {
          await this.rpc.call("main", "harness.sendCommand", harnessId, {
            type: "approve-tool",
            toolUseId: event.toolUseId,
            allow: false,
          });
          // Clear continuation flag — harness will resume (with denial)
          this.turns.setPendingContinuation(harnessId, false);
          break;
        }
        this.pendingCall(callId, channelId, 'approval', {
          harnessId,
          toolUseId: event.toolUseId,
        });
        const approvalParticipantInfo = this.getParticipantInfo(channelId);
        console.log(`[AiChatWorker] Requesting tool approval: tool=${event.toolName}, target=${panelId}, callId=${callId}`);

        // Async call via channel DO — result arrives at onCallResult
        const approvalChannel = this.createChannelClient(channelId);
        await approvalChannel.callMethod(
          this.getParticipantId(channelId)!,
          panelId,
          callId,
          'request_tool_approval',
          {
            agentId: this.getParticipantId(channelId) ?? harnessId,
            agentName: approvalParticipantInfo.name,
            toolName: event.toolName,
            toolArgs: event.input,
          },
        );
        break;
      }

      // --- Tool call from harness (async tool execution) ---
      case "tool-call": {
        this.pendingCall(event.callId, channelId, 'tool-call', {
          harnessId,
          callId: event.callId,
        });

        // Route tool call through channel DO
        const toolChannel = this.createChannelClient(channelId);
        await toolChannel.callMethod(
          this.getParticipantId(channelId)!,
          event.participantId,
          event.callId,
          event.method,
          event.args,
        );
        break;
      }

      // --- Discover methods request from harness ---
      case "discover-methods": {
        // Query PubSub roster for methods
        const discoverChannel = this.createChannelClient(channelId);
        const participants = await discoverChannel.getParticipants();
        const selfId = this.getParticipantId(channelId);
        const methods: Array<{ participantId: string; name: string; description: string; parameters?: unknown }> = [];
        for (const p of participants) {
          if (p.participantId === selfId) continue;
          const advertised = p.metadata["methods"];
          if (Array.isArray(advertised)) {
            for (const m of advertised) {
              const method = m as Record<string, unknown>;
              methods.push({
                participantId: p.participantId,
                name: method["name"] as string,
                description: (method["description"] as string) ?? "",
                ...(method["parameters"] ? { parameters: method["parameters"] } : {}),
              });
            }
          }
        }

        await this.rpc.call("main", "harness.sendCommand", harnessId, {
          type: "discover-methods-result",
          methods,
        });
        break;
      }

      // --- Metadata ---
      case "metadata-update": {
        const participantId = this.getParticipantId(channelId);
        if (participantId) {
          const metaChannel = this.createChannelClient(channelId);
          await metaChannel.updateMetadata(participantId, event.metadata);
        }
        break;
      }

    }

    // Persist stream state after every event that has a writer
    if (writer && event.type !== "turn-complete" && event.type !== "error") {
      this.persistStreamState(harnessId, writer);
    }
  }

  // --- Method calls ---

  override async onMethodCall(
    channelId: string,
    callId: string,
    methodName: string,
    _args: unknown,
  ): Promise<{ result: unknown; isError?: boolean }> {
    const activeId = this.getActiveHarness();

    switch (methodName) {
      case "pause":
        if (activeId) {
          const activeTurn = this.getActiveTurn(activeId);
          if (activeTurn?.channelId) {
            if (this.getParticipantId(activeTurn.channelId)) {
              const activeWriter = this.createWriter(activeTurn.channelId, activeTurn);
              await activeWriter.stopTyping();
              this.persistStreamState(activeId, activeWriter);
            }
            await this.cleanupBootstrapTyping(activeTurn.channelId);
          }
          await this.rpc.call("main", "harness.sendCommand", activeId, { type: "interrupt" });
          return { result: { paused: true } };
        }
        return { result: { error: "no active harness" }, isError: true };

      case "resume":
        return { result: { resumed: true } };

      default:
        return { result: { error: `unknown method: ${methodName}` }, isError: true };
    }
  }

  // --- Continuation results ---

  protected override async handleCallResult(
    type: string, context: Record<string, unknown>,
    channelId: string, result: unknown, isError: boolean,
  ): Promise<void> {
    switch (type) {
      case 'approval': {
        const { harnessId, toolUseId } = context as { harnessId: string; toolUseId: string };
        let allow = false;
        let alwaysAllow = false;
        if (!isError && result && typeof result === 'object') {
          const r = result as Record<string, unknown>;
          allow = r["allow"] === true;
          alwaysAllow = r["alwaysAllow"] === true;
        }
        const currentActiveId = this.getActiveHarness();
        if (currentActiveId === harnessId) {
          await this.rpc.call("main", "harness.sendCommand", harnessId, {
            type: "approve-tool",
            toolUseId,
            allow,
            alwaysAllow,
          });
        }
        break;
      }

      case 'tool-call': {
        const { harnessId, callId } = context as { harnessId: string; callId: string };
        // Deliver tool result back to harness
        await this.rpc.call("main", "harness.sendCommand", harnessId, {
          type: "tool-result",
          callId,
          result,
          isError,
        });
        break;
      }
    }
  }

  // --- Proactive turn ---

  /**
   * Start a turn proactively (without a user message triggering it).
   * Spawns a harness with the given content as initial input.
   * Use from subscribeChannel overrides when the agent should greet first.
   */
  protected async startProactiveTurn(channelId: string, content: string): Promise<void> {
    const participantId = this.getParticipantId(channelId);
    if (!participantId) throw new Error(`Not subscribed to channel ${channelId}`);

    const input = { content, senderId: "user" };
    const contextId = this.getContextId(channelId);
    const config = this.buildHarnessConfig(channelId);
    const harnessId = `harness-${crypto.randomUUID()}`;
    const participantInfo = this.getParticipantInfo(channelId);
    const typingContent = JSON.stringify({
      senderId: participantId,
      senderName: participantInfo.name,
      senderType: participantInfo.type,
    });

    this.registerHarness(harnessId, this.getHarnessType());
    // No replyToId — proactive turns have no trigger message
    this.setActiveTurn(harnessId, channelId, "", undefined, undefined, typingContent);
    this.setInFlightTurn(channelId, harnessId, "", 0, input);

    // Send bootstrap typing indicator
    const bootstrapTypingId = crypto.randomUUID();
    this.sql.exec(
      `INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)`,
      `bootstrap_typing:${channelId}`, bootstrapTypingId,
    );
    const channel = this.createChannelClient(channelId);
    await channel.send(participantId, bootstrapTypingId, typingContent, {
      contentType: "typing",
      persist: true,
    });
    this.adoptBootstrapTyping(harnessId, channelId);

    await this.rpc.call("main", "harness.spawn", {
      doRef: this.doRef,
      harnessId,
      type: this.getHarnessType(),
      contextId,
      config,
      initialInput: input,
    });
  }

  // --- Private helpers ---

  private async cleanupBootstrapTyping(channelId: string): Promise<void> {
    const key = `bootstrap_typing:${channelId}`;
    const row = this.sql.exec(`SELECT value FROM state WHERE key = ?`, key).toArray();
    if (row.length > 0) {
      const typingMsgId = row[0]!["value"] as string;
      const participantId = this.getParticipantId(channelId);
      if (participantId) {
        const channel = this.createChannelClient(channelId);
        await channel.complete(participantId, typingMsgId);
      }
      this.sql.exec(`DELETE FROM state WHERE key = ?`, key);
    }
  }

  private buildHarnessConfig(channelId: string): HarnessConfig {
    const base = this.getHarnessConfig();
    const sub = this.getSubscriptionConfig(channelId);
    if (!sub) return base;

    // systemPromptMode controls how the subscription prompt interacts with the
    // base CHAT_SYSTEM_PROMPT and SDK defaults:
    //   "append" (default) — subscription prompt layers on top of the base
    //   "replace-natstack" — subscription prompt replaces NatStack base, still appended to SDK defaults
    //   "replace" — subscription prompt replaces both NatStack base AND SDK defaults
    const subPrompt = sub["systemPrompt"] as string | undefined;
    const subMode = (sub["systemPromptMode"] as HarnessConfig["systemPromptMode"] | undefined);
    const mergedPrompt = subMode === "replace" || subMode === "replace-natstack"
      ? (subPrompt ?? base.systemPrompt)
      : subPrompt && base.systemPrompt
        ? `${base.systemPrompt}\n\n${subPrompt}`
        : subPrompt ?? base.systemPrompt;
    // "replace-natstack" swaps out the NatStack prompt but still appends to SDK defaults,
    // so it maps to "append" for the harness-level mode.
    const harnessMode = subMode === "replace-natstack" ? "append" : subMode;

    // toolAllowlist merge: subscription can only restrict (intersection), not expand.
    // This prevents a subscription from granting tools the worker class didn't intend.
    const subAllowlist = sub["toolAllowlist"] as string[] | undefined;
    let mergedAllowlist: string[] | undefined;
    if (subAllowlist && base.toolAllowlist) {
      const baseSet = new Set(base.toolAllowlist);
      mergedAllowlist = subAllowlist.filter(t => baseSet.has(t));
    } else if (subAllowlist) {
      mergedAllowlist = subAllowlist;
    } else {
      mergedAllowlist = base.toolAllowlist;
    }

    return {
      ...base,
      ...(mergedPrompt ? { systemPrompt: mergedPrompt } : {}),
      ...(harnessMode ? { systemPromptMode: harnessMode } : {}),
      ...(sub["model"] ? { model: sub["model"] as string } : {}),
      ...(sub["temperature"] != null
        ? { temperature: sub["temperature"] as number }
        : {}),
      ...(sub["maxTokens"] != null
        ? { maxTokens: sub["maxTokens"] as number }
        : {}),
      ...(mergedAllowlist ? { toolAllowlist: mergedAllowlist } : {}),
    };
  }

  private async handleHarnessCrash(
    harnessId: string,
    channelId: string,
    error: string,
  ): Promise<void> {
    this.sql.exec(
      `UPDATE harnesses SET status = 'crashed', state = ? WHERE id = ?`,
      JSON.stringify({ error, crashedAt: Date.now() }),
      harnessId,
    );

    const activeTurn = this.getActiveTurn(harnessId);
    if (activeTurn) {
      const writer = this.createWriter(channelId, activeTurn);
      await writer.stopTyping();
      await writer.endThinking();
      await writer.endAction();
      await writer.completeText();
    }
    await this.cleanupBootstrapTyping(channelId);

    const resumeSessionId = this.getResumeSessionId(harnessId);
    console.log(`[AiChatWorker] Crash recovery: harnessId=${harnessId}, resumeSessionId=${resumeSessionId ?? 'NONE'}`);

    const inFlight = this.getInFlightTurn(channelId, harnessId);
    const contextId = this.getContextId(channelId);

    this.clearActiveTurn(harnessId);
    this.clearTurnQueue(harnessId);

    // Re-register harness and record turn locally before respawn
    this.reactivateHarness(harnessId);
    if (inFlight) {
      this.recordTurnStart(harnessId, channelId, inFlight.turnInput,
        inFlight.triggerMessageId, inFlight.triggerPubsubId,
        activeTurn?.senderParticipantId ?? undefined);
    }

    // Respawn via server API
    await this.rpc.call("main", "harness.spawn", {
      doRef: this.doRef,
      harnessId,
      type: this.getHarnessType(),
      contextId,
      config: { ...this.buildHarnessConfig(channelId), extraEnv: { RESUME_SESSION_ID: resumeSessionId ?? "" } },
      initialInput: inFlight?.turnInput,
    });
  }
}
