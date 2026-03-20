import { AgentWorkerBase } from "@workspace/agentic-do";
import type { ChannelEvent, HarnessConfig, HarnessOutput, ParticipantDescriptor } from "@natstack/harness/types";


/**
 * AiChatWorker — The default AI chat Durable Object.
 *
 * Manages one-harness-per-channel AI conversations. All per-turn state
 * (active turns, in-flight turns, checkpoints) is stored in SQLite so
 * that no instance fields need to survive across DO invocations.
 *
 * Key flows:
 *   1. First user message → spawn harness via this.server.spawnHarness()
 *   2. Subsequent messages → start-turn command via this.server.sendHarnessCommand()
 *   3. Harness events → streamed to channel via StreamWriter (async PubSub HTTP)
 *   4. Crash recovery → respawn via this.server.spawnHarness()
 *   5. Tool approval → async via PubSub callMethod + onCallResult continuation
 *
 * All methods return void — side effects are direct HTTP calls, not action arrays.
 */
export class AiChatWorker extends AgentWorkerBase {
  static override schemaVersion = 3;

  // --- Hook overrides ---

  protected override getHarnessConfig(): HarnessConfig {
    return {
      toolAllowlist: ["eval", "feedback_form", "feedback_custom", "set_title", "inline_ui"],
    };
  }

  protected override getParticipantInfo(
    _channelId: string,
    _config?: unknown,
  ): ParticipantDescriptor {
    return {
      handle: "ai-chat",
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
    const harnessId = this.getHarnessForChannel(channelId);
    const participantId = this.getParticipantId(channelId);

    // Build typing data with proper display name
    const participantInfo = this.getParticipantInfo(channelId);
    const typingContent = JSON.stringify({
      senderId: event.senderId,
      senderName: participantInfo.name,
      senderType: participantInfo.type,
    });

    if (!harnessId) {
      // No active harness — spawn one with the first turn bundled.
      const contextId = this.getContextId(channelId);
      const config = this.buildHarnessConfig(channelId);

      // Resume from the most recent session on this channel (restart recovery)
      const resumeSessionId = this.getResumeSessionIdForChannel(channelId);
      if (resumeSessionId) {
        config.extraEnv = { ...config.extraEnv, RESUME_SESSION_ID: resumeSessionId };
      }

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
          persist: false,
          replyTo: event.messageId,
        });
      }

      // Spawn harness via server API
      await this.server.spawnHarness({
        doRef: this.doRef,
        harnessId: `harness-${crypto.randomUUID()}`,
        type: this.getHarnessType(),
        contextId,
        config,
        senderParticipantId: event.senderId,
        initialTurn: {
          input,
          triggerMessageId: event.messageId,
          triggerPubsubId: event.id,
        },
      });
    } else {
      // Existing harness — start a new turn
      this.setActiveTurn(harnessId, channelId, event.messageId, undefined, event.senderId, typingContent);

      // Start typing via StreamWriter
      const newTurn = this.getActiveTurn(harnessId)!;
      const turnWriter = this.createWriter(channelId, newTurn);
      await turnWriter.startTyping();
      this.persistStreamState(harnessId, turnWriter);

      this.setInFlightTurn(channelId, harnessId, event.messageId, event.id, input);
      this.advanceCheckpoint(channelId, harnessId, event.id);

      // Send start-turn command to harness
      await this.server.sendHarnessCommand(harnessId, {
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
    const channelId =
      turn?.channelId ?? this.getChannelForHarness(harnessId);

    if (!channelId) return;

    // Create a StreamWriter for events that produce channel output
    const writer = turn ? this.createWriter(channelId, turn) : null;

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
        await writer?.startTyping();
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
        await writer?.stopTyping();
        if (writer) this.persistStreamState(harnessId, writer);

        // Check if channel's approval level allows auto-approval
        if (this.shouldAutoApprove(channelId, event.toolName)) {
          await this.server.sendHarnessCommand(harnessId, {
            type: "approve-tool",
            toolUseId: event.toolUseId,
            allow: true,
          });
          if (writer) {
            await writer.startTyping();
            this.persistStreamState(harnessId, writer);
          }
          break;
        }

        // Needs user input — route to panel
        const callId = crypto.randomUUID();
        const activeTurnForApproval = this.getActiveTurn(harnessId);
        const panelId = activeTurnForApproval?.senderParticipantId;
        if (!panelId) {
          await this.server.sendHarnessCommand(harnessId, {
            type: "approve-tool",
            toolUseId: event.toolUseId,
            allow: false,
          });
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
        await writer?.stopTyping();
        if (writer) this.persistStreamState(harnessId, writer);

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

        await this.server.sendHarnessCommand(harnessId, {
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

      // --- Interleave point (no-op) ---
      case "interleave-point":
        break;

      // --- Ready (harness initialized) ---
      case "ready":
        this.sql.exec(
          `UPDATE harnesses SET status = 'active' WHERE id = ?`,
          harnessId,
        );
        break;
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
    const harnessId = this.getHarnessForChannel(channelId);

    switch (methodName) {
      case "pause":
        if (harnessId) {
          await this.server.sendHarnessCommand(harnessId, { type: "interrupt" });
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
        const activeHarnessId = this.getHarnessForChannel(channelId);
        if (activeHarnessId === harnessId) {
          await this.server.sendHarnessCommand(harnessId, {
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
        await this.server.sendHarnessCommand(harnessId, {
          type: "tool-result",
          callId,
          result,
          isError,
        });
        break;
      }
    }
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

    return {
      ...base,
      ...(sub["systemPrompt"] ? { systemPrompt: sub["systemPrompt"] as string } : {}),
      ...(sub["model"] ? { model: sub["model"] as string } : {}),
      ...(sub["temperature"] != null
        ? { temperature: sub["temperature"] as number }
        : {}),
      ...(sub["maxTokens"] != null
        ? { maxTokens: sub["maxTokens"] as number }
        : {}),
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

    const senderParticipantId = activeTurn?.senderParticipantId ?? undefined;
    const resumeSessionId = this.getResumeSessionId(harnessId);
    console.log(`[AiChatWorker] Crash recovery: harnessId=${harnessId}, resumeSessionId=${resumeSessionId ?? 'NONE'}`);

    const inFlight = this.getInFlightTurn(channelId, harnessId);
    const contextId = this.getContextId(channelId);

    const initialTurn = inFlight
      ? {
          input: inFlight.turnInput,
          triggerMessageId: inFlight.triggerMessageId,
          triggerPubsubId: inFlight.triggerPubsubId,
        }
      : undefined;

    this.clearActiveTurn(harnessId);

    // Respawn via server API
    await this.server.spawnHarness({
      doRef: this.doRef,
      harnessId,
      type: this.getHarnessType(),
      contextId,
      config: { ...this.buildHarnessConfig(channelId), extraEnv: { RESUME_SESSION_ID: resumeSessionId ?? "" } },
      senderParticipantId,
      initialTurn,
    });
  }
}
