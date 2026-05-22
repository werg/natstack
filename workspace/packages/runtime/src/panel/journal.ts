export type PanelJournalEntry =
  | { type: "open"; source: string; id: string; kind: "workspace" | "browser" }
  | { type: "reload"; id: string }
  | { type: "close"; id: string }
  | { type: "stateArgs.set"; id: string };

export class Journal {
  readonly entries: PanelJournalEntry[] = [];

  append(entry: PanelJournalEntry): void {
    this.entries.push(entry);
  }
}

let current: Journal | null = null;

export async function withJournal<T>(journal: Journal, fn: () => Promise<T> | T): Promise<T> {
  if (current) throw new Error("A panel operation journal is already active");
  current = journal;
  try {
    return await fn();
  } finally {
    current = null;
  }
}

export function currentJournal(): Journal | null {
  return current;
}
