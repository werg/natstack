/**
 * Vault controller — owns vault selection and the workspace path index.
 *
 * GAD-native: the path index comes from `vcs.listFiles()` (the vault's ctx
 * head), filtered to `.mdx` and mapped to vault-relative paths via the
 * {@link VaultPathMapping}. There is no `fs` walk. File creation records the new
 * doc as a tracked working `vcs.edit` so it appears in the index immediately
 * (committed + published later via Publish).
 *
 * Switching vault is a panel **reopen** under the new vault's stable
 * contextId (`vault-<hash>`), not a runtime `repoRoot` swap — only reopening
 * rebinds `vcs.*` (and the scribe) to the new vault's durable head. First-run
 * starter docs are passed through stateArgs and created by the reopened panel,
 * so the tracked working edit lands on the vault's own context head.
 */

import { panel, vcs } from "@workspace/runtime";
import type { Store } from "./store";
import type { SpectroliteState } from "./state";
import { createQueuedRefresh } from "./queuedRefresh";
import { vaultContextId, vaultPathMapping, normalizeVaultPath, type VaultPathMapping } from "./vaultContext";

export interface VaultControllerHooks {
  /** Notify the session layer (agent scope update / default-agent bootstrap). */
  onVaultSelected(repoRoot: string): void;
}

export interface VaultStarterDoc {
  /** Vault-relative path, e.g. `Welcome.mdx`. */
  path: string;
  content: string;
}

export class VaultController {
  private pathsEpoch = 0;
  private readonly pathsRefresh = createQueuedRefresh();

  constructor(
    private readonly store: Store<SpectroliteState>,
    private readonly hooks: VaultControllerHooks,
  ) {}

  /** The mapping for the active vault (vault-relative ↔ workspace-relative vcs paths). */
  mapping(): VaultPathMapping {
    return vaultPathMapping(this.store.getState().repoRoot ?? "");
  }

  /**
   * Pick a vault from the picker. The vault head is durable + per-vault, so
   * binding to it means reopening the panel under `vault-<hash>`. We persist
   * the selection in the new context's stateArgs via `reopen`.
   */
  selectVault(contextPath: string, options?: { starterDoc?: VaultStarterDoc }): void {
    const repoRoot = normalizeVaultPath(contextPath);
    const stateArgs: Record<string, unknown> = { repoRoot, openPath: undefined };
    if (options?.starterDoc) stateArgs["pendingStarterDoc"] = options.starterDoc;
    void panel.reopen({
      contextId: vaultContextId(repoRoot),
      stateArgs,
    }).catch((err) => {
      console.warn("[Spectrolite] reopen for vault select failed:", err);
    });
  }

  /** Forget the selection so the picker shows (reopen without a repoRoot). */
  async switchVault(): Promise<void> {
    await panel.reopen({ stateArgs: { repoRoot: undefined, openPath: undefined } }).catch((err) => {
      console.warn("[Spectrolite] reopen for vault switch failed:", err);
    });
  }

  refreshPaths(): Promise<void> {
    return this.pathsRefresh.run(async () => {
      const root = this.store.getState().repoRoot;
      if (root === null) {
        this.store.setState({ paths: [], pathsLoading: false });
        return;
      }
      const mapping = vaultPathMapping(root);
      const epoch = this.pathsEpoch;
      this.store.setState({ pathsLoading: true });
      try {
        const entries = await vcs.listFiles();
        if (epoch !== this.pathsEpoch) return;
        const paths = entries
          .map((entry) => mapping.toVaultRelPath(entry.path))
          .filter((p): p is string => p !== null && /\.mdx$/i.test(p))
          .sort((a, b) => a.localeCompare(b));
        this.store.setState({ paths, pathsLoading: false, pathsLoaded: true });
      } catch (err) {
        console.warn("[Spectrolite] listFiles failed:", err);
        if (epoch !== this.pathsEpoch) return;
        this.store.setState({ paths: [], pathsLoading: false, pathsLoaded: true });
      }
    });
  }

  /**
   * Create a file (exclusive — refuses to clobber an existing note). Returns
   * the final vault-relative path on success, or the existing path when the
   * file is already there. Records the empty doc as a tracked working `vcs.edit`
   * on the vault head (no commit — Publish folds + pushes it later).
   */
  async createFile(relPath: string, initialContent: string): Promise<string> {
    const root = this.store.getState().repoRoot;
    if (root === null) throw new Error("No vault selected");
    const finalPath = relPath.endsWith(".mdx") ? relPath : `${relPath}.mdx`;
    const mapping = vaultPathMapping(root);
    const vcsPath = mapping.toVcsPath(finalPath);

    const existing = await vcs.readFile("", vcsPath).catch(() => null);
    if (existing) return finalPath; // already exists — caller just opens it

    await vcs.edit({
      edits: [{ kind: "create", path: vcsPath, content: { kind: "text", text: initialContent } }],
    });
    void this.refreshPaths();
    return finalPath;
  }
}
