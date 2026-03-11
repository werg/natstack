import type { WorkerAction, WorkerActions, TurnInput, SendOptions, SpawnHarnessOpts, RespawnHarnessOpts } from "@natstack/harness";
import { StreamWriter, type PersistedStreamState } from "./stream-writer.js";

export class ActionCollector {
  private actionList: WorkerAction[] = [];
  private registeredWriters: Array<{ harnessId: string; writer: StreamWriter }> = [];
  private ownerDO: { persistStreamState(harnessId: string, writer: StreamWriter): void };

  constructor(ownerDO: { persistStreamState(harnessId: string, writer: StreamWriter): void }) {
    this.ownerDO = ownerDO;
  }

  channel(channelId: string): ChannelActions {
    return new ChannelActions(channelId, this.actionList, this);
  }

  harness(harnessId: string): HarnessActions {
    return new HarnessActions(harnessId, this.actionList);
  }

  spawnHarness(opts: SpawnHarnessOpts): this {
    this.actionList.push({ target: 'system', op: 'spawn-harness', ...opts });
    return this;
  }

  respawnHarness(opts: RespawnHarnessOpts): this {
    this.actionList.push({ target: 'system', op: 'respawn-harness', ...opts });
    return this;
  }

  forkChannel(source: string, forkPointId: number): this {
    this.actionList.push({ target: 'system', op: 'fork-channel', sourceChannel: source, forkPointId });
    return this;
  }

  setAlarm(delayMs: number): this {
    this.actionList.push({ target: 'system', op: 'set-alarm', delayMs });
    return this;
  }

  /** Register a StreamWriter for auto-persistence on result() */
  registerWriter(harnessId: string, writer: StreamWriter): void {
    this.registeredWriters.push({ harnessId, writer });
  }

  /** Build the final WorkerActions. Auto-persists all StreamWriter state. */
  result(): WorkerActions {
    for (const { harnessId, writer } of this.registeredWriters) {
      this.ownerDO.persistStreamState(harnessId, writer);
    }
    return { actions: this.actionList };
  }
}

export class ChannelActions {
  constructor(
    private channelId: string,
    private actions: WorkerAction[],
    private collector: ActionCollector
  ) {}

  send(content: string, options?: SendOptions): this {
    const messageId = crypto.randomUUID();
    this.actions.push({ target: 'channel', channelId: this.channelId, op: 'send', messageId, content, options });
    return this;
  }

  /** Send a message with a caller-controlled ID (for tracking/cleanup). */
  sendTracked(messageId: string, content: string, options?: SendOptions): this {
    this.actions.push({ target: 'channel', channelId: this.channelId, op: 'send', messageId, content, options });
    return this;
  }

  update(messageId: string, content: string): this {
    this.actions.push({ target: 'channel', channelId: this.channelId, op: 'update', messageId, content });
    return this;
  }

  complete(messageId: string): this {
    this.actions.push({ target: 'channel', channelId: this.channelId, op: 'complete', messageId });
    return this;
  }

  methodResult(callId: string, content: unknown, isError?: boolean): this {
    this.actions.push({ target: 'channel', channelId: this.channelId, op: 'method-result', callId, content, isError });
    return this;
  }

  updateMetadata(metadata: Record<string, unknown>): this {
    this.actions.push({ target: 'channel', channelId: this.channelId, op: 'update-metadata', metadata });
    return this;
  }

  sendEphemeral(content: string, contentType: string): this {
    this.actions.push({ target: 'channel', channelId: this.channelId, op: 'send-ephemeral', content, contentType });
    return this;
  }

  callMethod(callId: string, participantId: string, method: string, args: unknown): this {
    this.actions.push({ target: 'channel', channelId: this.channelId, op: 'call-method', callId, participantId, method, args });
    return this;
  }

  /** Create a StreamWriter that auto-persists its message ID when $.result() is called */
  streamFor(
    harnessId: string,
    turn: { replyToId: string; typingContent: string; streamState: PersistedStreamState },
  ): StreamWriter {
    const writer = new StreamWriter(
      this.channelId,
      turn.replyToId,
      turn.typingContent,
      turn.streamState,
      this.actions,
    );
    this.collector.registerWriter(harnessId, writer);
    return writer;
  }
}

export class HarnessActions {
  constructor(private harnessId: string, private actions: WorkerAction[]) {}

  startTurn(input: TurnInput): this {
    this.actions.push({ target: 'harness', harnessId: this.harnessId, command: { type: 'start-turn', input } });
    return this;
  }

  approveTool(toolUseId: string, allow: boolean, alwaysAllow?: boolean): this {
    this.actions.push({ target: 'harness', harnessId: this.harnessId, command: { type: 'approve-tool', toolUseId, allow, alwaysAllow } });
    return this;
  }

  interrupt(): this {
    this.actions.push({ target: 'harness', harnessId: this.harnessId, command: { type: 'interrupt' } });
    return this;
  }

  fork(forkPointMessageId: number, turnSessionId: string): this {
    this.actions.push({ target: 'harness', harnessId: this.harnessId, command: { type: 'fork', forkPointMessageId, turnSessionId } });
    return this;
  }

  dispose(): this {
    this.actions.push({ target: 'harness', harnessId: this.harnessId, command: { type: 'dispose' } });
    return this;
  }
}
