/**
 * Three-way merge over GAD worktree states (WS3.P4).
 *
 * Runs server-side: manifests come from the gad store, file bytes from the
 * blobstore CAS, content merges through the vendored diff3. The merged (or
 * conflict-marked provisional) state is staged as a value in the store; a
 * clean merge commits `state.merge_applied` immediately, a conflicted merge
 * parks a pending-merge ref on the target head and materializes the
 * provisional tree for resolution — the resolving commit completes it.
 *
 * Standard case table per path over (base, ours, theirs):
 *   unchanged/unchanged → keep            changed/unchanged → take changed
 *   added one side      → take addition   deleted one side (other unchanged) → delete
 *   both changed same   → take it         both changed differently → diff3 (text) / conflict (binary)
 *   add/add same        → take it         add/add different → diff3 / conflict
 *   delete vs change    → conflict (keep changed side's content with markers impossible → keep change, flag)
 */

import { getBytes, putBytes } from "../services/blobstoreService.js";
import { diff3Merge } from "./diff3.js";
import type { GadCaller } from "./store.js";

interface StateFile {
  path: string;
  content_hash: string;
  mode: number;
}

export interface MergeConflict {
  path: string;
  kind: "content" | "binary" | "delete-vs-change" | "mode";
}

export interface MergeComputation {
  status: "clean" | "conflicted" | "up-to-date" | "fast-forward";
  files: Array<{ path: string; contentHash: string; size: number; mode: number }>;
  conflicts: MergeConflict[];
  baseStateHash: string | null;
}

export interface MergeEngineDeps {
  blobsDir: string;
  gad: GadCaller;
}

function byPath(files: StateFile[]): Map<string, StateFile> {
  return new Map(files.map((file) => [file.path, file]));
}

function looksBinary(bytes: Buffer): boolean {
  const probe = bytes.subarray(0, 8192);
  return probe.includes(0);
}

/**
 * 3-way merge of the file mode, independent of content. A mode changed on
 * exactly one side is taken; both sides changing it to different values is a
 * conflict (ours kept provisionally). Without this, the content arm would force
 * a single side's mode and silently drop a legitimate chmod (e.g. +x).
 */
function resolveMode(
  b: StateFile | undefined,
  o: StateFile,
  t: StateFile
): { mode: number; conflict: boolean } {
  const base = b?.mode;
  const oursChanged = o.mode !== base;
  const theirsChanged = t.mode !== base;
  if (oursChanged && theirsChanged) {
    return o.mode === t.mode ? { mode: o.mode, conflict: false } : { mode: o.mode, conflict: true };
  }
  if (theirsChanged) return { mode: t.mode, conflict: false };
  // Only ours changed, or neither changed (o.mode === base): ours' mode wins.
  return { mode: o.mode, conflict: false };
}

export class MergeEngine {
  constructor(private readonly deps: MergeEngineDeps) {}

  private async stateFiles(stateHash: string | null): Promise<StateFile[]> {
    if (!stateHash) return [];
    return await this.deps.gad.call<StateFile[]>("listStateFiles", { stateHash });
  }

  private async readBlob(digest: string): Promise<Buffer> {
    const bytes = await getBytes(this.deps.blobsDir, digest);
    if (!bytes) throw new Error(`merge: blob missing from CAS: ${digest}`);
    return bytes;
  }

  /**
   * Compute the merge of `theirs` into `ours`, discovering the merge base from
   * the transition DAG. Pure over store values — no refs are moved and nothing
   * is appended; callers commit the result.
   */
  async compute(
    oursStateHash: string,
    theirsStateHash: string,
    labels: { ours: string; theirs: string }
  ): Promise<MergeComputation> {
    if (oursStateHash === theirsStateHash) {
      return { status: "up-to-date", files: [], conflicts: [], baseStateHash: oursStateHash };
    }
    const { baseStateHash } = await this.deps.gad.call<{ baseStateHash: string | null }>(
      "getMergeBase",
      { leftStateHash: oursStateHash, rightStateHash: theirsStateHash }
    );
    return this.mergeFromBase(baseStateHash, oursStateHash, theirsStateHash, labels);
  }

  /**
   * Compute the merge of `theirs` into `ours` against an explicitly supplied
   * `base` — for callers (e.g. `applyEdits`) that authored `ours` as an
   * in-memory draft off a known base and never recorded a DAG edge to it.
   * Avoids the `getMergeBase` lookup entirely.
   */
  async compute3(
    input: { base: string | null; ours: string; theirs: string },
    labels: { ours: string; theirs: string }
  ): Promise<MergeComputation> {
    if (input.ours === input.theirs) {
      return { status: "up-to-date", files: [], conflicts: [], baseStateHash: input.ours };
    }
    return this.mergeFromBase(input.base, input.ours, input.theirs, labels);
  }

  /** Shared 3-way merge body once the base state hash is known. */
  private async mergeFromBase(
    baseStateHash: string | null,
    oursStateHash: string,
    theirsStateHash: string,
    labels: { ours: string; theirs: string }
  ): Promise<MergeComputation> {
    if (baseStateHash === theirsStateHash) {
      return { status: "up-to-date", files: [], conflicts: [], baseStateHash };
    }

    const [baseFiles, oursFiles, theirsFiles] = await Promise.all([
      this.stateFiles(baseStateHash),
      this.stateFiles(oursStateHash),
      this.stateFiles(theirsStateHash),
    ]);
    if (baseStateHash === oursStateHash) {
      return {
        status: "fast-forward",
        files: theirsFiles.map((file) => ({
          path: file.path,
          contentHash: file.content_hash,
          size: 0,
          mode: file.mode,
        })),
        conflicts: [],
        baseStateHash,
      };
    }

    const base = byPath(baseFiles);
    const ours = byPath(oursFiles);
    const theirs = byPath(theirsFiles);
    const allPaths = [...new Set([...base.keys(), ...ours.keys(), ...theirs.keys()])].sort();

    const merged: Array<{ path: string; contentHash: string; size: number; mode: number }> = [];
    const conflicts: MergeConflict[] = [];
    const keep = (file: StateFile): void => {
      merged.push({ path: file.path, contentHash: file.content_hash, size: 0, mode: file.mode });
    };

    for (const path of allPaths) {
      const b = base.get(path);
      const o = ours.get(path);
      const t = theirs.get(path);
      const oursChanged =
        (o?.content_hash ?? null) !== (b?.content_hash ?? null) ||
        (o?.mode ?? null) !== (b?.mode ?? null);
      const theirsChanged =
        (t?.content_hash ?? null) !== (b?.content_hash ?? null) ||
        (t?.mode ?? null) !== (b?.mode ?? null);

      if (!oursChanged && !theirsChanged) {
        if (o) keep(o);
        continue;
      }
      if (oursChanged && !theirsChanged) {
        if (o) keep(o); // includes ours-deleted (o absent → drop)
        continue;
      }
      if (theirsChanged && !oursChanged) {
        if (t) keep(t);
        continue;
      }
      // Both changed.
      if (o && t && o.content_hash === t.content_hash) {
        const m = resolveMode(b, o, t);
        keep({ ...o, mode: m.mode });
        if (m.conflict) conflicts.push({ path, kind: "mode" });
        continue;
      }
      if (!o && !t) continue; // both deleted
      if (!o || !t) {
        // delete vs change — keep the surviving change, flag the conflict
        conflicts.push({ path, kind: "delete-vs-change" });
        keep((o ?? t)!);
        continue;
      }
      // Content-level: diff3 when all three are text.
      const [baseBytes, oursBytes, theirsBytes] = await Promise.all([
        b ? this.readBlob(b.content_hash) : Promise.resolve(Buffer.alloc(0)),
        this.readBlob(o.content_hash),
        this.readBlob(t.content_hash),
      ]);
      if (looksBinary(baseBytes) || looksBinary(oursBytes) || looksBinary(theirsBytes)) {
        conflicts.push({ path, kind: "binary" });
        keep(o); // ours wins provisionally; theirs recoverable from its state
        continue;
      }
      const result = diff3Merge(
        baseBytes.toString("utf8"),
        oursBytes.toString("utf8"),
        theirsBytes.toString("utf8"),
        { oursLabel: labels.ours, theirsLabel: labels.theirs }
      );
      const bytes = Buffer.from(result.text, "utf8");
      const { digest, size } = await putBytes(this.deps.blobsDir, bytes);
      const m = resolveMode(b, o, t);
      merged.push({ path, contentHash: digest, size, mode: m.mode });
      if (!result.ok) conflicts.push({ path, kind: "content" });
      if (m.conflict) conflicts.push({ path, kind: "mode" });
    }

    return {
      status: conflicts.length === 0 ? "clean" : "conflicted",
      files: merged,
      conflicts,
      baseStateHash,
    };
  }
}
