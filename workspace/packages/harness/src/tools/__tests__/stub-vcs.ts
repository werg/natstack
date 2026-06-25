import type {
  ToolVcs,
  ToolVcsCommitResult,
  ToolVcsEditOp,
  ToolVcsEditResult,
  ToolVcsMergeResult,
  ToolVcsPushResult,
} from "../tool-vcs.js";

export interface StubVcsInit {
  files?: Record<string, string>;
}

function normalize(path: string): string {
  return path.replace(/^\/+/, "");
}

function editResult(edits: ToolVcsEditOp[], stateHash: string, editSeq: number): ToolVcsEditResult {
  return {
    head: "ctx:test",
    stateHash,
    committed: false,
    status: "uncommitted",
    editSeq,
    changedPaths: edits.map((edit) => normalize(edit.path)),
  };
}

export class StubVcs implements ToolVcs {
  readonly files = new Map<string, string>();
  /** The most recent `edit` call's input — lets tests assert provenance
   *  threading (e.g. that the edit/write tools pass their toolCallId as
   *  `invocationId`, the edge into the agentic trajectory). */
  lastEditInput?: { edits: ToolVcsEditOp[]; repoPath?: string; invocationId?: string };
  private version = 0;

  constructor(init?: StubVcsInit) {
    for (const [path, text] of Object.entries(init?.files ?? {})) {
      this.files.set(normalize(path), text);
    }
  }

  read(path: string): string | undefined {
    return this.files.get(normalize(path));
  }

  async readFile(
    path: string
  ): Promise<{ content: { kind: "text"; text: string }; stateHash: string } | null> {
    const text = this.read(path);
    if (text == null) return null;
    return { content: { kind: "text", text }, stateHash: `state-${this.version}` };
  }

  async edit(input: {
    edits: ToolVcsEditOp[];
    baseStateHash?: string;
    repoPath?: string;
    invocationId?: string;
  }): Promise<ToolVcsEditResult> {
    this.lastEditInput = input;
    for (const edit of input.edits) {
      const path = normalize(edit.path);
      if (edit.kind === "write" || edit.kind === "create") {
        if (edit.content.kind !== "text") {
          throw new Error("StubVcs only supports text content");
        }
        this.files.set(path, edit.content.text);
        continue;
      }
      if (edit.kind === "delete") {
        this.files.delete(path);
        continue;
      }
      if (edit.kind === "chmod") continue;

      // replace: apply hunks against the current working content. A working edit
      // is append-only — a stale offset is the caller's bug, surfaced as a throw
      // (there is no merge/conflict at the edit layer anymore).
      const existing = this.files.get(path);
      if (existing == null) throw new Error(`StubVcs: replace target not found: ${path}`);
      let next = existing;
      const hunks = [...edit.hunks].sort((a, b) => b.start - a.start);
      for (const hunk of hunks) {
        if (hunk.oldText != null && next.slice(hunk.start, hunk.end) !== hunk.oldText) {
          throw new Error(`StubVcs: replace hunk did not match at ${path}`);
        }
        next = next.slice(0, hunk.start) + hunk.newText + next.slice(hunk.end);
      }
      this.files.set(path, next);
    }
    this.version++;
    return editResult(input.edits, `state-${this.version}`, this.version);
  }

  async commit(input: { message: string; repoPaths?: string[] }): Promise<ToolVcsCommitResult[]> {
    this.version++;
    const repoPaths = input.repoPaths ?? ["meta"];
    return repoPaths.map((repoPath) => ({
      repoPath,
      head: "ctx:test",
      stateHash: `state-${this.version}`,
      eventId: `event-${this.version}`,
      headHash: `head-${this.version}`,
      editCount: 0,
      status: "committed" as const,
      changedPaths: [],
    }));
  }

  async push(input: { repoPaths: string[] }): Promise<ToolVcsPushResult> {
    return { status: "pushed", repoPaths: input.repoPaths, reports: [] };
  }

  async merge(_repoPath: string): Promise<ToolVcsMergeResult> {
    return {
      status: "up-to-date",
      stateHash: `state-${this.version}`,
      conflicts: [],
      mergeable: "clean",
      upstreamCommits: [],
    };
  }

  async discardEdits(_repoPath: string): Promise<{ discarded: number; stateHash: string }> {
    return { discarded: 0, stateHash: `state-${this.version}` };
  }
}
