/**
 * Vault picker — first-run landing screen.
 *
 *   - Lists existing `projects/*` directories from the workspace tree.
 *   - Lets the user create a new vault, which:
 *       1. mkdir's `/projects/<name>/` in the context fs
 *       2. writes a starter `Welcome.mdx`
 *       3. runs `git init` + initial commit + push so the workspace source
 *          tree gets the new repo (visible to future contexts and to
 *          `getWorkspaceTree`).
 *
 * Sits in place of an "empty state" — Spectrolite always asks the user
 * which knowledge base they want to work on rather than guessing a
 * default path.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { promises as fs } from "fs";
import { Box, Button, Callout, Card, Code, Flex, Heading, Spinner, Text, TextField } from "@radix-ui/themes";
import { ExclamationTriangleIcon, FilePlusIcon, FileTextIcon, ReloadIcon } from "@radix-ui/react-icons";
import { GitClient, initAndPush, type FsPromisesLike } from "@natstack/git";
import { gitConfig } from "@workspace/runtime";
import { discoverVaults, vaultContextPath, validateVaultName, type VaultEntry } from "../state/vaultDiscovery";

const WELCOME_BODY = `---
title: Welcome
dependencies: {}
---

# Welcome to your new vault

Start typing here. Try the following:

1. **@-mention an agent** by typing \`@\` — it can edit this file directly.
2. **Link** to other notes with double brackets: [[Another Note]].
3. **Commit** changes from the strip at the bottom of the editor.

Replace this file with your own content when you're ready.
`;

function gitClient(): GitClient | null {
  if (!gitConfig?.serverUrl) return null;
  return new GitClient(fs as unknown as FsPromisesLike, {
    serverUrl: gitConfig.serverUrl,
    token: gitConfig.token,
  });
}

export interface VaultPickerProps {
  agentHandle?: string;
  onSelect: (contextPath: string) => void;
}

export function VaultPicker({ agentHandle, onSelect }: VaultPickerProps) {
  const [vaults, setVaults] = useState<VaultEntry[] | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setVaults(null);
    void discoverVaults().then((v) => { if (!cancelled) setVaults(v); });
    return () => { cancelled = true; };
  }, [refreshNonce]);

  const validationError = useMemo(() => newName.trim() ? validateVaultName(newName) : null, [newName]);
  const duplicateName = useMemo(() => {
    if (!vaults || !newName.trim()) return false;
    return vaults.some((v) => v.name === newName.trim());
  }, [vaults, newName]);

  const handleCreate = useCallback(async () => {
    const trimmed = newName.trim();
    const err = validateVaultName(trimmed);
    if (err) { setCreateError(err); return; }
    if (duplicateName) { setCreateError(`A vault named "${trimmed}" already exists`); return; }
    setCreateError(null);
    setCreating(true);
    try {
      const dir = vaultContextPath(trimmed);
      // mkdir is idempotent — if a concurrent creator beat us we'd see
      // the existence at the writeFile step instead.
      await fs.mkdir(dir, { recursive: true });
      const git = gitClient();
      if (!git) {
        // No git server available — write the starter file with exclusive
        // create so a concurrent vault creation can't clobber it. The
        // user gets a working vault but no version control until they
        // restart the workspace (which will git-init projects/*).
        const fsWithFlags = fs as unknown as { writeFile(p: string, data: string, opts?: { flag?: string }): Promise<void> };
        try {
          await fsWithFlags.writeFile(`${dir}/Welcome.mdx`, WELCOME_BODY, { flag: "wx" });
        } catch (writeErr) {
          const msg = writeErr instanceof Error ? writeErr.message : String(writeErr);
          if (!/eexist/i.test(msg)) throw writeErr;
          // EEXIST: a concurrent creator already produced Welcome.mdx.
          // Preserve their content and just open the vault.
        }
      } else {
        // initAndPush handles init + initial commit + push back to the
        // workspace's projects/<name> repo. The remote URL "projects/<name>"
        // is resolved by the git client against gitConfig.serverUrl. If
        // the repo or file already exists, git init is idempotent and
        // the commit step skips when there are no changes.
        await initAndPush(git, fs as unknown as FsPromisesLike, {
          dir,
          remote: `projects/${trimmed}`,
          branch: "main",
          initialFiles: { "Welcome.mdx": WELCOME_BODY },
          message: "Initial commit",
        });
      }
      onSelect(dir);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [newName, duplicateName, onSelect]);

  return (
    <Flex align="center" justify="center" style={{ height: "100%" }} p="6">
      <Flex direction="column" gap="4" style={{ maxWidth: 640, width: "100%" }}>
        <Box>
          <Heading size="4">Spectrolite</Heading>
          <Text size="2" color="gray" as="p">
            A live MDX knowledge base with a resident editing agent
            {agentHandle ? <> — <Text weight="medium">@{agentHandle}</Text> is already in the room.</> : ""}
            {" "}Each vault is a folder under <Code>projects/</Code> in your workspace; the workspace
            keeps it as a git repo automatically.
          </Text>
        </Box>

        <Card>
          <Flex direction="column" gap="2">
            <Flex align="center" justify="between">
              <Text size="2" weight="medium">Open an existing vault</Text>
              <Button size="1" variant="ghost" color="gray" onClick={() => setRefreshNonce((n) => n + 1)} aria-label="Refresh vault list">
                <ReloadIcon />
              </Button>
            </Flex>
            {vaults === null ? (
              <Flex align="center" gap="2"><Spinner /> <Text size="1" color="gray">Scanning workspace…</Text></Flex>
            ) : vaults.length === 0 ? (
              <Text size="1" color="gray">No vaults yet. Create one below.</Text>
            ) : (
              <Flex direction="column" gap="0">
                {vaults.map((v) => (
                  <Button
                    key={v.relPath}
                    variant="ghost"
                    color="gray"
                    onClick={() => onSelect(v.contextPath)}
                    style={{ justifyContent: "flex-start" }}
                  >
                    <FileTextIcon />
                    <Text size="2" weight="medium">{v.name}</Text>
                    <Text size="1" color="gray">— {v.relPath}</Text>
                    {!v.isGitRepo ? <Text size="1" color="amber">(not a git repo yet)</Text> : null}
                  </Button>
                ))}
              </Flex>
            )}
          </Flex>
        </Card>

        <Card>
          <Flex direction="column" gap="2">
            <Text size="2" weight="medium">Create a new vault</Text>
            <Flex gap="2">
              <TextField.Root
                size="2"
                placeholder="my-notes"
                value={newName}
                onChange={(e) => { setNewName(e.target.value); if (createError) setCreateError(null); }}
                onKeyDown={(e) => { if (e.key === "Enter" && !validationError && !duplicateName) void handleCreate(); }}
                style={{ flex: 1 }}
                disabled={creating}
              />
              <Button
                size="2"
                onClick={() => void handleCreate()}
                disabled={creating || !newName.trim() || validationError !== null || duplicateName}
              >
                {creating ? <Spinner /> : <FilePlusIcon />} Create
              </Button>
            </Flex>
            {validationError ? (
              <Text size="1" color="red">{validationError}</Text>
            ) : duplicateName ? (
              <Text size="1" color="red">A vault named "{newName.trim()}" already exists</Text>
            ) : (
              <Text size="1" color="gray">
                Will be created at <Code>projects/{newName.trim() || "<name>"}</Code> with a starter
                <Code> Welcome.mdx</Code>.
              </Text>
            )}
            {createError ? (
              <Callout.Root size="1" color="red">
                <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
                <Callout.Text size="1">{createError}</Callout.Text>
              </Callout.Root>
            ) : null}
          </Flex>
        </Card>
      </Flex>
    </Flex>
  );
}
