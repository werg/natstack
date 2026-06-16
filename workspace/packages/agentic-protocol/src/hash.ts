import { agenticSlice, type AgenticEvent, type TrajectoryEvent } from "./events.js";

export { canonicalJson, sortForCanonicalJson } from "./canonical-json.js";
import { canonicalJson } from "./canonical-json.js";

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function computeEventHash(input: {
  prevEventHash: string;
  branchId: string;
  seq: number;
  event: AgenticEvent;
}): Promise<string> {
  return sha256Hex(`${input.prevEventHash}${input.branchId}${input.seq}${canonicalJson(input.event)}`);
}

export async function verifyEventHash(event: TrajectoryEvent): Promise<boolean> {
  const expected = await computeEventHash({
    prevEventHash: event.prevEventHash,
    branchId: event.branchId,
    seq: event.seq,
    event: agenticSlice(event),
  });
  return expected === event.eventHash;
}

export async function checkTrajectoryIntegrity(events: TrajectoryEvent[]): Promise<{
  ok: boolean;
  errors: string[];
}> {
  const errors: string[] = [];
  const byBranch = new Map<string, TrajectoryEvent[]>();
  for (const event of events) {
    const branchEvents = byBranch.get(event.branchId) ?? [];
    branchEvents.push(event);
    byBranch.set(event.branchId, branchEvents);
  }

  for (const [branchId, branchEvents] of byBranch) {
    const ordered = [...branchEvents].sort((a, b) => a.seq - b.seq);
    for (let index = 0; index < ordered.length; index += 1) {
      const event = ordered[index];
      if (!event) continue;
      if (index > 0) {
        const previous = ordered[index - 1];
        if (previous && event.prevEventHash !== previous.eventHash) {
          errors.push(`branch ${branchId} seq ${event.seq} prevEventHash does not match seq ${previous.seq}`);
        }
      }
      if (!(await verifyEventHash(event))) {
        errors.push(`branch ${branchId} seq ${event.seq} eventHash mismatch`);
      }
    }
  }

  return { ok: errors.length === 0, errors };
}
