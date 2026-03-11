/**
 * executeActions -- the SINGLE path for executing all DO action results.
 *
 * Both channel events and harness events flow through here after the DO
 * returns its WorkerActions. Each action is dispatched to the appropriate
 * subsystem (PubSub, harness, system).
 */

import { randomUUID } from "crypto";
import type { WorkerActions, WorkerAction, HarnessCommand } from "@natstack/harness";
import type { PubSubFacade } from "./services/pubsubFacade.js";
import type { HarnessManager } from "./harnessManager.js";
import type { WorkerRouter } from "./workerRouter.js";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("executeActions");

export interface ExecuteActionsContext {
  facade: PubSubFacade;
  harnessManager: HarnessManager;
  router: WorkerRouter;
  /** Ensure a context folder exists (workspace copy + plugin manifest) */
  ensureContextFolder(contextId: string): Promise<string>;
  /** Which participant generated these actions */
  participantId: string;
}

/**
 * Execute all actions returned by a DO method call.
 */
export async function executeActions(
  actions: WorkerActions,
  context: ExecuteActionsContext,
): Promise<void> {
  for (const action of actions.actions) {
    try {
      switch (action.target) {
        case "channel":
          context.facade.executeChannelAction(action, context.participantId);
          break;
        case "harness":
          await executeHarnessAction(action, context);
          break;
        case "system":
          await executeSystemAction(action, context);
          break;
        default:
          log.warn(`Unknown action target: ${(action as WorkerAction).target}`);
      }
    } catch (err) {
      log.error(`Error executing action (target=${action.target}):`, err);
    }
  }
}

// ─── Harness actions ────────────────────────────────────────────────────────

async function executeHarnessAction(
  action: WorkerAction & { target: "harness" },
  context: ExecuteActionsContext,
): Promise<void> {
  const bridge = context.harnessManager.getHarnessBridge(action.harnessId);
  if (!bridge) {
    log.error(`No bridge for harness ${action.harnessId}, skipping ${action.command.type} command — harness may have crashed`);
    // Notify the owning DO so it can clean up (stop typing indicators, etc.)
    const doReg = context.router.getDOForHarness(action.harnessId);
    if (doReg) {
      try {
        const errorActions = await context.router.dispatch(
          doReg.className, doReg.objectKey,
          "onHarnessEvent", action.harnessId,
          { type: "error", error: `Harness bridge lost while executing ${action.command.type}`, code: "bridge-lost" },
        );
        if (errorActions?.actions?.length > 0) {
          // Execute channel actions only (skip harness actions to avoid recursion)
          for (const a of errorActions.actions) {
            if (a.target === "channel") {
              context.facade.executeChannelAction(a, context.participantId);
            }
          }
        }
      } catch (err) {
        log.error(`Failed to notify DO of lost bridge for ${action.harnessId}:`, err);
      }
    }
    return;
  }

  const cmd = action.command;
  const { method, args } = commandToRpc(cmd);

  if (cmd.type === "start-turn") {
    // Fire-and-forget: startTurn awaits the entire SDK query (minutes).
    // Blocking here would freeze the facade's event queue, preventing
    // new user messages from reaching the DO. Harness events flow back
    // independently via pushEvent RPC.
    bridge.call(action.harnessId, method, ...args).catch((err) => {
      log.error(`start-turn failed for harness ${action.harnessId}:`, err);
    });
  } else {
    await bridge.call(action.harnessId, method, ...args);
  }
}

/**
 * Map a HarnessCommand to the RPC method name and args.
 * Command types are kebab-case but the harness exposes camelCase methods.
 */
function commandToRpc(cmd: HarnessCommand): { method: string; args: unknown[] } {
  switch (cmd.type) {
    case "start-turn":
      return { method: "startTurn", args: [cmd.input] };
    case "approve-tool":
      return { method: "approveTool", args: [cmd.toolUseId, cmd.allow, cmd.alwaysAllow] };
    case "interrupt":
      return { method: "interrupt", args: [] };
    case "fork":
      return { method: "fork", args: [cmd.forkPointMessageId, cmd.turnSessionId] };
    case "dispose":
      return { method: "dispose", args: [] };
  }
}

// ─── System actions ─────────────────────────────────────────────────────────

async function executeSystemAction(
  action: WorkerAction & { target: "system" },
  context: ExecuteActionsContext,
): Promise<void> {
  switch (action.op) {
    case "spawn-harness":
      await handleSpawnHarness(action, context);
      break;
    case "respawn-harness":
      await handleRespawnHarness(action, context);
      break;
    case "fork-channel":
      await handleForkChannel(action, context);
      break;
    case "set-alarm":
      handleSetAlarm(action, context);
      break;
    default:
      log.warn(`Unknown system op: ${(action as { op: string }).op}`);
  }
}

// ─── spawn-harness: full 7-step bootstrap ───────────────────────────────────

async function handleSpawnHarness(
  action: WorkerAction & { target: "system"; op: "spawn-harness" },
  context: ExecuteActionsContext,
): Promise<void> {
  const { router, harnessManager, facade } = context;
  const harnessId = `harness:${randomUUID()}`;
  const doReg = facade.getHandle(context.participantId);
  if (!doReg) {
    log.error(`spawn-harness: no participant entry for ${context.participantId}`);
    return;
  }

  const { className, objectKey } = doReg;

  // Step 1: Register harness with the router (server-side)
  router.registerHarness(harnessId, className, objectKey);

  // Step 1b: Register harness in the DO's SQLite so getHarnessForChannel
  // returns non-null and prevents duplicate spawns from concurrent events.
  await router.dispatch(className, objectKey, "registerHarness", harnessId, action.channelId, action.type);

  try {
    // Step 2: Ensure the context folder exists (workspace copy + skills + plugin manifest).
    // Must happen before spawn so the harness process gets CONTEXT_FOLDER_PATH.
    const contextFolderPath = await context.ensureContextFolder(action.contextId);

    // Step 3: Spawn the harness process.
    // Serialize the full HarnessConfig as HARNESS_CONFIG so the adapter
    // receives systemPrompt, model, toolAllowlist, etc. — not just extraEnv.
    const configEnv: Record<string, string> = action.config
      ? { HARNESS_CONFIG: JSON.stringify(action.config) }
      : {};
    await harnessManager.spawn({
      id: harnessId,
      type: action.type,
      workerId: `${className}:${objectKey}`,
      channel: action.channelId,
      contextId: action.contextId,
      contextFolderPath,
      extraEnv: { ...action.config?.extraEnv, ...configEnv },
    });

    // Step 3: Wait for harness to authenticate (bridge becomes available)
    const bridge = await harnessManager.waitForBridge(harnessId);

    // Step 4: Notify the DO that the harness is ready via onHarnessEvent
    const notifyActions = await router.dispatch(
      className,
      objectKey,
      "onHarnessEvent",
      harnessId,
      { type: "ready" },
    );

    // Step 5: Execute any actions from the notification
    if (notifyActions && notifyActions.actions.length > 0) {
      await executeActions(notifyActions, context);
    }

    // Step 6: Record turn state in DO before starting the turn
    if (action.initialTurn) {
      const { input, triggerMessageId, triggerPubsubId } = action.initialTurn;
      await router.dispatch(
        className,
        objectKey,
        "recordTurnStart",
        harnessId,
        action.channelId,
        input,
        triggerMessageId,
        triggerPubsubId,
        action.senderParticipantId,
      );

      // Step 7: Start the first turn on the harness (fire-and-forget,
      // same rationale as executeHarnessAction — startTurn blocks for minutes)
      bridge.call(harnessId, "startTurn", input).catch((err) => {
        log.error(`Initial start-turn failed for harness ${harnessId}:`, err);
      });
    }

    log.info(
      `Harness ${harnessId} spawned for DO ${className}/${objectKey} (type=${action.type})`,
    );
  } catch (err) {
    log.error(`spawn-harness failed for ${harnessId}:`, err);
    // Clean up on failure
    router.unregisterHarness(harnessId);
    try {
      await harnessManager.stop(harnessId);
    } catch {
      // Already stopped or never started
    }

    // Notify the DO of the failure via onHarnessEvent
    try {
      const failActions = await router.dispatch(
        className,
        objectKey,
        "onHarnessEvent",
        harnessId,
        { type: "error", error: String(err), code: "spawn-failed" },
      );
      if (failActions && failActions.actions.length > 0) {
        await executeActions(failActions, context);
      }
    } catch {
      // Best effort
    }
  }
}

// ─── respawn-harness ────────────────────────────────────────────────────────

async function handleRespawnHarness(
  action: WorkerAction & { target: "system"; op: "respawn-harness" },
  context: ExecuteActionsContext,
): Promise<void> {
  const { router, harnessManager, facade } = context;
  const harnessId = action.harnessId;
  const doReg = facade.getHandle(context.participantId);
  if (!doReg) {
    log.error(`respawn-harness: no participant entry for ${context.participantId}`);
    return;
  }

  const { className, objectKey } = doReg;

  // Re-register the harness with the router (it may have been unregistered on crash)
  router.registerHarness(harnessId, className, objectKey);

  // Re-activate harness in DO's SQLite (re-sets status to 'starting')
  await router.dispatch(className, objectKey, "reactivateHarness", harnessId);

  try {
    // Spawn with resume session if available
    await harnessManager.spawn({
      id: harnessId,
      type: "claude-sdk", // respawn uses same type
      workerId: `${className}:${objectKey}`,
      channel: action.channelId,
      contextId: action.contextId,
      resumeSessionId: action.resumeSessionId,
    });

    const bridge = await harnessManager.waitForBridge(harnessId);

    // Notify DO via onHarnessEvent
    const notifyActions = await router.dispatch(
      className,
      objectKey,
      "onHarnessEvent",
      harnessId,
      { type: "ready" },
    );
    if (notifyActions && notifyActions.actions.length > 0) {
      await executeActions(notifyActions, context);
    }

    // Record and retry turn if provided
    if (action.retryTurn) {
      const { input, triggerMessageId, triggerPubsubId } = action.retryTurn;
      await router.dispatch(
        className,
        objectKey,
        "recordTurnStart",
        harnessId,
        action.channelId,
        input,
        triggerMessageId,
        triggerPubsubId,
        action.senderParticipantId,
      );
      bridge.call(harnessId, "startTurn", input).catch((err) => {
        log.error(`Respawn start-turn failed for harness ${harnessId}:`, err);
      });
    }

    log.info(`Harness ${harnessId} respawned for DO ${className}/${objectKey}`);
  } catch (err) {
    log.error(`respawn-harness failed for ${harnessId}:`, err);
    router.unregisterHarness(harnessId);
    try {
      await harnessManager.stop(harnessId);
    } catch {
      // Already stopped
    }
  }
}

// ─── fork-channel ───────────────────────────────────────────────────────────

async function handleForkChannel(
  action: WorkerAction & { target: "system"; op: "fork-channel" },
  context: ExecuteActionsContext,
): Promise<void> {
  const doReg = context.facade.getHandle(context.participantId);
  if (!doReg) {
    log.error(`fork-channel: no participant entry for ${context.participantId}`);
    return;
  }

  // Generate a new channel ID for the fork
  const forkedChannelId = `fork:${action.sourceChannel}:${randomUUID().slice(0, 8)}`;

  log.info(
    `Fork channel: ${action.sourceChannel} at message ${action.forkPointId} -> ${forkedChannelId}`,
  );

  // Notify the DO of the new fork channel
  try {
    const forkActions = await context.router.dispatch(
      doReg.className,
      doReg.objectKey,
      "onChannelForked",
      action.sourceChannel,
      forkedChannelId,
      action.forkPointId,
    );
    if (forkActions && forkActions.actions.length > 0) {
      await executeActions(forkActions, context);
    }
  } catch (err) {
    log.error(`fork-channel notification failed:`, err);
  }
}

// ─── set-alarm ──────────────────────────────────────────────────────────────

function handleSetAlarm(
  action: WorkerAction & { target: "system"; op: "set-alarm" },
  context: ExecuteActionsContext,
): void {
  const doReg = context.facade.getHandle(context.participantId);
  if (!doReg) {
    log.error(`set-alarm: no participant entry for ${context.participantId}`);
    return;
  }

  const { className, objectKey } = doReg;

  setTimeout(async () => {
    try {
      const alarmActions = await context.router.dispatch(
        className,
        objectKey,
        "onAlarm",
      );
      if (alarmActions && alarmActions.actions.length > 0) {
        await executeActions(alarmActions, {
          ...context,
          // Use the same participant context for alarm-triggered actions
        });
      }
    } catch (err) {
      log.error(`Alarm handler failed for ${className}/${objectKey}:`, err);
    }
  }, action.delayMs);

  log.info(`Alarm set for ${className}/${objectKey} in ${action.delayMs}ms`);
}
