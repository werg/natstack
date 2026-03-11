import { AgentWorkerBase } from "@workspace/runtime/worker";
import type { ChannelEvent, HarnessConfig, HarnessOutput, WorkerActions, ParticipantDescriptor } from "@natstack/harness";


/**
 * AiChatWorker — The default AI chat Durable Object.
 *
 * Manages one-harness-per-channel AI conversations. All per-turn state
 * (active turns, in-flight turns, checkpoints) is stored in SQLite so
 * that no instance fields need to survive across DO invocations.
 *
 * Key flows:
 *   1. First user message → spawnHarness with initialTurn
 *   2. Subsequent messages → startTurn on existing harness
 *   3. Harness events → streamed to channel via StreamWriter
 *   4. Crash recovery → respawnHarness with retryTurn from in_flight_turns
 *   5. Tool approval → routed through feedback_form continuations
 */
export class AiChatWorker extends AgentWorkerBase {
  static override schemaVersion = 2;

  // --- Hook overrides ---

  protected override getHarnessConfig(): HarnessConfig {
    return {
      // Only expose the eval tool to the model — other methods
      // (feedback_form, feedback_custom, request_tool_approval)
      // are callable via callMethod but not as AI model tools.
      toolAllowlist: ["eval"],
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

  // --- Channel events ---

  async onChannelEvent(
    channelId: string,
    event: ChannelEvent,
  ): Promise<WorkerActions> {
    const $ = this.actions();

    // Filter: only process events that match shouldProcess
    if (!this.shouldProcess(event)) {
      this.advanceCheckpoint(channelId, null, event.id);
      return $.result();
    }

    const input = this.buildTurnInput(event);
    const harnessId = this.getHarnessForChannel(channelId);

    // Build typing data with proper display name
    const participantInfo = this.getParticipantInfo(channelId);
    const typingContent = JSON.stringify({
      senderId: event.senderId,
      senderName: participantInfo.name,
      senderType: participantInfo.type,
    });

    if (!harnessId) {
      // No active harness — spawn one with the first turn bundled.
      // Send a tracked typing indicator so the user sees immediate feedback
      // during the multi-step harness bootstrap. The message ID is stored
      // so recordTurnStart can adopt it into the StreamWriter for cleanup.
      const contextId = this.getContextId(channelId);
      const config = this.buildHarnessConfig(channelId);
      const bootstrapTypingId = crypto.randomUUID();
      this.sql.exec(
        `INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)`,
        `bootstrap_typing:${channelId}`, bootstrapTypingId,
      );
      $.channel(channelId).sendTracked(bootstrapTypingId, typingContent, { type: "typing", persist: false });
      $.spawnHarness({
        type: this.getHarnessType(),
        channelId,
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
      // Existing harness — start a new turn with managed typing lifecycle
      $.harness(harnessId).startTurn(input);

      // Record turn state in SQLite (includes sender participant ID for approval routing)
      this.setActiveTurn(harnessId, channelId, event.messageId, undefined, event.senderId, typingContent);

      // Start typing via StreamWriter so it's properly tracked and stopped
      // when the first content event (thinking-start, text-start, etc.) arrives
      const newTurn = this.getActiveTurn(harnessId)!;
      const turnWriter = $.channel(channelId).streamFor(harnessId, newTurn);
      turnWriter.startTyping();

      this.setInFlightTurn(
        channelId,
        harnessId,
        event.messageId,
        event.id,
        input,
      );
      this.advanceCheckpoint(channelId, harnessId, event.id);
    }

    return $.result();
  }

  // --- Harness events ---

  async onHarnessEvent(
    harnessId: string,
    event: HarnessOutput,
  ): Promise<WorkerActions> {
    const $ = this.actions();
    const turn = this.getActiveTurn(harnessId);
    const channelId =
      turn?.channelId ?? this.getChannelForHarness(harnessId);

    if (!channelId) {
      // Orphan event — harness has no associated channel
      return $.result();
    }

    // Create a StreamWriter for events that produce channel output
    const writer =
      turn
        ? $.channel(channelId).streamFor(harnessId, turn)
        : null;

    switch (event.type) {
      // --- Thinking lifecycle ---
      case "thinking-start":
        writer?.startThinking();
        break;

      case "thinking-delta":
        writer?.updateThinking(event.content);
        break;

      case "thinking-end":
        writer?.endThinking();
        break;

      // --- Text streaming ---
      case "text-start":
        writer?.startText(event.metadata);
        break;

      case "text-delta":
        writer?.updateText(event.content);
        break;

      case "text-end":
        writer?.completeText();
        break;

      // --- Tool actions ---
      case "action-start":
        writer?.startAction(event.tool, event.description, event.toolUseId);
        break;

      case "action-end":
        writer?.endAction();
        // Restart typing — model is now processing the tool result
        writer?.startTyping();
        break;

      // --- Inline UI ---
      case "inline-ui":
        writer?.sendInlineUi(event.data);
        break;

      // --- Message / turn completion ---
      case "message-complete":
        // Message boundary within a multi-message turn — no-op for now
        break;

      case "turn-complete": {
        console.log(`[AiChatWorker] Turn complete: harnessId=${harnessId}, sessionId=${event.sessionId}, channelId=${channelId}`);
        // Finalize any outstanding stream artifacts before clearing state
        if (writer) {
          writer.stopTyping();
          writer.endThinking();
          writer.endAction();
          writer.completeText();
        }

        // Record turn in turn_map for fork resolution (read AFTER finalization
        // so persistStreamState has updated turn_message_id)
        const activeTurn = this.getActiveTurn(harnessId);
        if (activeTurn?.turnMessageId) {
          const inFlight = this.getInFlightTurn(
            channelId,
            harnessId,
          );
          this.recordTurn(
            harnessId,
            activeTurn.turnMessageId,
            inFlight?.triggerPubsubId ?? 0,
            event.sessionId,
          );
        }
        // Clear turn state
        this.clearActiveTurn(harnessId);
        this.clearInFlightTurn(channelId, harnessId);
        break;
      }

      // --- Error handling ---
      case "error":
        if (event.code) {
          // Turn-level error (e.g., error_max_turns, error_during_execution).
          // The harness process is still alive — complete partial output and
          // send an error message, but do NOT respawn. The subsequent
          // turn-complete event will record the turn and clean up state.
          if (writer) {
            writer.stopTyping();
            writer.endThinking();
            writer.endAction();
            writer.completeText();
          }
          this.cleanupBootstrapTyping($, channelId);
          $.channel(channelId).send(
            JSON.stringify({ error: event.error, code: event.code }),
            { type: "error", persist: true, replyTo: turn?.replyToId },
          );
        } else {
          // Process-level crash (no code) — full crash recovery
          return this.handleHarnessCrashWithActions(
            $,
            harnessId,
            channelId,
            event.error,
          );
        }
        break;

      // --- Approval (via PubSub RPC + continuation) ---
      case "approval-needed": {
        // Stop typing — user is seeing an approval dialog, not a "thinking" state
        writer?.stopTyping();
        const callId = crypto.randomUUID();
        const activeTurnForApproval = this.getActiveTurn(harnessId);
        const panelId = activeTurnForApproval?.senderParticipantId;
        if (!panelId) {
          // No panel to ask — deny by default
          $.harness(harnessId).approveTool(event.toolUseId, false);
          break;
        }
        // Store continuation — survives hibernation
        this.pendingCall(callId, channelId, 'approval', {
          harnessId,
          toolUseId: event.toolUseId,
        });
        const approvalParticipantInfo = this.getParticipantInfo(channelId);
        console.log(`[AiChatWorker] Requesting tool approval: tool=${event.toolName}, target=${panelId}, callId=${callId}, harnessId=${harnessId}`);

        // Call request_tool_approval on the panel — routes through the
        // panel's approval policy layer (checkToolApproval for auto-approve,
        // requestApproval for UI prompt with per-agent grants).
        $.channel(channelId).callMethod(callId, panelId, 'request_tool_approval', {
          agentId: this.getParticipantId(channelId) ?? harnessId,
          agentName: approvalParticipantInfo.name,
          toolName: event.toolName,
          toolArgs: event.input,
        });
        break;
      }

      // --- Metadata ---
      case "metadata-update":
        $.channel(channelId).updateMetadata(event.metadata);
        break;

      // --- Interleave point (no-op, server handles scheduling) ---
      case "interleave-point":
        break;

      // --- Ready (harness initialized, update status) ---
      case "ready":
        this.sql.exec(
          `UPDATE harnesses SET status = 'active' WHERE id = ?`,
          harnessId,
        );
        break;
    }

    return $.result();
  }

  // --- Method calls ---

  override async onMethodCall(
    channelId: string,
    callId: string,
    methodName: string,
    _args: unknown,
  ): Promise<WorkerActions> {
    const $ = this.actions();
    const harnessId = this.getHarnessForChannel(channelId);

    switch (methodName) {
      case "pause":
        if (harnessId) {
          $.harness(harnessId).interrupt();
          $.channel(channelId).methodResult(callId, { paused: true });
        } else {
          $.channel(channelId).methodResult(
            callId,
            { error: "no active harness" },
            true,
          );
        }
        break;

      case "resume":
        // Resume is a no-op — the next user message will trigger a new turn
        $.channel(channelId).methodResult(callId, { resumed: true });
        break;

      default:
        $.channel(channelId).methodResult(
          callId,
          { error: `unknown method: ${methodName}` },
          true,
        );
        break;
    }

    return $.result();
  }

  // --- Continuation results ---

  protected override handleCallResult(
    type: string, context: Record<string, unknown>,
    channelId: string, result: unknown, isError: boolean,
  ): WorkerActions {
    const $ = this.actions();

    switch (type) {
      case 'approval': {
        console.log(`[AiChatWorker] Approval result received: harnessId=${(context as any).harnessId}, allow=${!isError && result && typeof result === 'object' && (result as any).allow}, isError=${isError}`);
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
          console.log(`[AiChatWorker] Forwarding approval to harness: toolUseId=${toolUseId}, allow=${allow}, alwaysAllow=${alwaysAllow}`);
          $.harness(harnessId).approveTool(toolUseId, allow, alwaysAllow);
        } else {
          console.warn(`[AiChatWorker] Approval result for stale harness: expected=${activeHarnessId}, got=${harnessId}, callId context dropped`);
        }
        break;
      }
    }

    return $.result();
  }

  // --- Private helpers ---

  /**
   * Complete and remove any bootstrap typing message for a channel.
   * Called during error/crash paths in case recordTurnStart never adopted it.
   */
  private cleanupBootstrapTyping($: ReturnType<typeof this.actions>, channelId: string): void {
    const key = `bootstrap_typing:${channelId}`;
    const row = this.sql.exec(`SELECT value FROM state WHERE key = ?`, key).toArray();
    if (row.length > 0) {
      const typingMsgId = row[0]!["value"] as string;
      $.channel(channelId).complete(typingMsgId);
      this.sql.exec(`DELETE FROM state WHERE key = ?`, key);
    }
  }

  /**
   * Build the full HarnessConfig, merging base config with any
   * per-channel subscription config overrides.
   */
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

  /**
   * Handle a harness crash: mark it crashed, complete any partial stream,
   * and return a respawn action with the in-flight turn for retry.
   */
  private handleHarnessCrashWithActions(
    $: ReturnType<typeof this.actions>,
    harnessId: string,
    channelId: string,
    error: string,
  ): WorkerActions {
    // Mark harness as crashed
    this.sql.exec(
      `UPDATE harnesses SET status = 'crashed', state = ? WHERE id = ?`,
      JSON.stringify({ error, crashedAt: Date.now() }),
      harnessId,
    );

    // Finalize any partial streaming messages
    const activeTurn = this.getActiveTurn(harnessId);
    if (activeTurn) {
      const writer = $.channel(channelId).streamFor(harnessId, activeTurn);
      writer.stopTyping();
      writer.endThinking();
      writer.endAction();
      writer.completeText();
    }
    // Clean up bootstrap typing in case spawn failed before recordTurnStart
    this.cleanupBootstrapTyping($, channelId);

    // Capture sender before clearing turn state (needed for approval during retry)
    const senderParticipantId = activeTurn?.senderParticipantId ?? undefined;

    // Get resume session ID for conversation continuity
    const resumeSessionId = this.getResumeSessionId(harnessId);
    console.log(`[AiChatWorker] Crash recovery: harnessId=${harnessId}, resumeSessionId=${resumeSessionId ?? 'NONE (first turn never completed)'}`);

    // Read in-flight turn for retry
    const inFlight = this.getInFlightTurn(channelId, harnessId);
    const contextId = this.getContextId(channelId);

    const retryTurn = inFlight
      ? {
          input: inFlight.turnInput,
          triggerMessageId: inFlight.triggerMessageId,
          triggerPubsubId: inFlight.triggerPubsubId,
        }
      : undefined;

    // Clear turn state before respawn
    this.clearActiveTurn(harnessId);
    // Keep in_flight_turns — the server will clear on successful respawn

    $.respawnHarness({
      harnessId,
      channelId,
      contextId,
      resumeSessionId,
      senderParticipantId,
      retryTurn,
    });

    return $.result();
  }

}
