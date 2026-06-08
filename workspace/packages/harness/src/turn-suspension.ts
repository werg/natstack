/**
 * TurnSuspensionSignal — the typed "pause this turn for an external event" signal.
 *
 * Thrown from `getApiKey` (and, later, other indeterminate-latency callbacks) to
 * unwind the model request while keeping the turn OPEN. It replaces the old
 * overloaded `AgentWorkerError("auth", <magic string>)`: pi-runner recognizes the
 * TYPE (not a string), keeps the turn open, and suppresses the channel publish of
 * the failure message — so a paused turn is never surfaced as a red error.
 *
 * The `message` deliberately carries the same human-readable text the resume path
 * keys off in the persisted session transcript (the live signal is typed; the
 * persisted message is plain data, so its detection stays text-based by nature).
 */
export interface TurnSuspensionInit {
  /** The suspension reason (e.g. "credential"). */
  reason: string;
  /** Human-readable message; also the persisted assistant-error text. */
  message: string;
  /** Deferred-call correlation id, when fronted by a deferred RPC. */
  requestId?: string;
}

export class TurnSuspensionSignal extends Error {
  /** Brand for cross-realm-safe `instanceof`-free detection. */
  readonly natstackTurnSuspension = true as const;
  readonly reason: string;
  readonly requestId: string | undefined;

  constructor(init: TurnSuspensionInit) {
    super(init.message);
    this.name = "TurnSuspensionSignal";
    this.reason = init.reason;
    this.requestId = init.requestId;
  }
}

export function isTurnSuspensionSignal(err: unknown): err is TurnSuspensionSignal {
  return Boolean(
    err &&
      typeof err === "object" &&
      (err as { natstackTurnSuspension?: unknown }).natstackTurnSuspension === true
  );
}
