/**
 * Vault controller — owns vault selection and the workspace path index.
 *
 * GAD-native: the path index comes from `vcs.listFiles()` (the vault's ctx
 * head), filtered to `.mdx` and mapped to vault-relative paths via the
 * {@link VaultPathMapping}. There is no `fs` walk. File creation commits an
 * empty doc through `vcs.applyEdits` so it appears in the index + every peer.
 *
 * Switching vault is a panel **reopen** under the new vault's stable
 * contextId (`vault-<hash>`), not a runtime `repoRoot` swap — only reopening
 * rebinds `vcs.*` (and the scribe) to the new vault's durable head.
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
  selectVault(contextPath: string): void {
    const repoRoot = normalizeVaultPath(contextPath);
    void panel.reopen({
      contextId: vaultContextId(repoRoot),
      stateArgs: { repoRoot, openPath: undefined },
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
   * file is already there. Commits an empty doc through the vault head.
   */
  async createFile(relPath: string, initialContent: string): Promise<string> {
    const root = this.store.getState().repoRoot;
    if (root === null) throw new Error("No vault selected");
    const finalPath = relPath.endsWith(".mdx") ? relPath : `${relPath}.mdx`;
    const mapping = vaultPathMapping(root);
    const vcsPath = mapping.toVcsPath(finalPath);

    const existing = await vcs.readFile("", vcsPath).catch(() => null);
    if (existing) return finalPath; // already exists — caller just opens it

    const result = await vcs.applyEdits({
      edits: [{ kind: "create", path: vcsPath, content: { kind: "text", text: initialContent } }],
    });
    if (result.status === "conflicted") {
      // Lost a create race — the file now exists; just open it.
      return finalPath;
    }
    void this.refreshPaths();
    return finalPath;
  }
}
