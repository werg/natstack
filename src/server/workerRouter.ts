/**
 * WorkerRouter -- central registry mapping relationships between PubSub
 * participants, harness processes, and Durable Objects.
 *
 * Also provides the `dispatch()` method for calling DO methods through
 * the injected dispatcher (HTTP fetch to workerd's /_do/ routes).
 */

import type { WorkerActions } from "@natstack/harness";
import { createDevLogger } from "@natstack/dev-log";

const log = createDevLogger("WorkerRouter");

export interface DORegistration {
  className: string;
  objectKey: string;
}

/**
 * A dispatcher function that calls a DO method and returns actions.
 * Injected by the server wiring to decouple from transport specifics.
 */
export type DODispatcher = (
  className: string,
  objectKey: string,
  method: string,
  ...args: unknown[]
) => Promise<WorkerActions>;

export class WorkerRouter {
  /** participantId -> DO registration */
  private participantToDO = new Map<string, DORegistration>();

  /** harnessId -> DO registration */
  private harnessToDO = new Map<string, DORegistration>();

  /** Injected dispatcher for actually calling DO methods */
  private dispatcher: DODispatcher | null = null;

  /**
   * Set the dispatcher function used by `dispatch()`.
   * Must be called before any dispatch calls.
   */
  setDispatcher(fn: DODispatcher): void {
    this.dispatcher = fn;
  }

  // ── Registration ──────────────────────────────────────────────────────

  /** Register a PubSub participant as associated with a DO */
  registerParticipant(
    participantId: string,
    className: string,
    objectKey: string,
  ): void {
    this.participantToDO.set(participantId, { className, objectKey });
    log.info(`Registered participant ${participantId} -> ${className}/${objectKey}`);
  }

  /** Register a harness as owned by a DO */
  registerHarness(
    harnessId: string,
    className: string,
    objectKey: string,
  ): void {
    this.harnessToDO.set(harnessId, { className, objectKey });
    log.info(`Registered harness ${harnessId} -> ${className}/${objectKey}`);
  }

  /** Remove a harness registration */
  unregisterHarness(harnessId: string): void {
    this.harnessToDO.delete(harnessId);
  }

  // ── Lookups ───────────────────────────────────────────────────────────

  /** Get the DO registration for a harness */
  getDOForHarness(harnessId: string): DORegistration | undefined {
    return this.harnessToDO.get(harnessId);
  }

  /** Get the DO for a participant */
  getDOForParticipant(participantId: string): DORegistration | undefined {
    return this.participantToDO.get(participantId);
  }

  /**
   * Get all participant IDs registered for a given DO (className+objectKey).
   * Useful for finding which participants are subscribed to channels.
   */
  getParticipantsForDO(className: string, objectKey: string): string[] {
    const result: string[] = [];
    for (const [pid, reg] of this.participantToDO) {
      if (reg.className === className && reg.objectKey === objectKey) {
        result.push(pid);
      }
    }
    return result;
  }

  /**
   * Get all harness IDs registered for a given DO.
   */
  getHarnessesForDO(className: string, objectKey: string): string[] {
    const result: string[] = [];
    for (const [hid, reg] of this.harnessToDO) {
      if (reg.className === className && reg.objectKey === objectKey) {
        result.push(hid);
      }
    }
    return result;
  }

  // ── Dispatch ──────────────────────────────────────────────────────────

  /**
   * Dispatch a method call to a DO via its service bridge.
   * Returns the WorkerActions for the server to execute.
   */
  async dispatch(
    className: string,
    objectKey: string,
    method: string,
    ...args: unknown[]
  ): Promise<WorkerActions> {
    if (!this.dispatcher) {
      throw new Error("WorkerRouter: no dispatcher configured");
    }
    return this.dispatcher(className, objectKey, method, ...args);
  }
}
