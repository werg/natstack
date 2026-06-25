/**
 * Vault picker — first-run landing screen.
 *
 *   - Lists existing `projects/*` directories from the workspace tree.
 *   - Lets the user create a new vault. The picker reopens into that vault's
 *     stable context; the reopened panel records the starter Welcome.mdx there.
 *
 * Spectrolite always asks which knowledge base to work on rather than
 * guessing a default path.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Callout, Card, Code, Flex, Heading, IconButton, Spinner, Text, TextField } from "@radix-ui/themes";
import { ArchiveIcon, ExclamationTriangleIcon, FilePlusIcon, ReloadIcon } from "@radix-ui/react-icons";
import { useIsMobile } from "@workspace/react";
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

export interface VaultPickerProps {
  agentHandle?: string;
  onSelect: (
    contextPath: string,
    options?: { starterDoc?: { path: string; content: string } }
  ) => void;
}

export function VaultPicker({ agentHandle, onSelect }: VaultPickerProps) {
  const isMobile = useIsMobile();
  const [vaults, setVaults] = useState<VaultEntry[] | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setVaults(null);
    setDiscoverError(null);
    discoverVaults()
      .then((v) => { if (!cancelled) setVaults(v); })
      .catch((err) => {
        if (cancelled) return;
        setVaults([]);
        setDiscoverError(err instanceof Error ? err.message : String(err));
      });
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
      onSelect(dir, {
        starterDoc: {
          path: "Welcome.mdx",
          content: WELCOME_BODY,
        },
      });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }, [newName, duplicateName, onSelect]);

  return (
    <Flex align={isMobile ? "start" : "center"} justify="center" className="spectrolite-picker" style={{ minHeight: "100%" }} p={isMobile ? "4" : "6"}>
      <Flex direction="column" gap="5" style={{ maxWidth: 560, width: "100%" }}>
        <Flex direction="column" gap="2" align="center" mt={isMobile ? "4" : "0"}>
          <span className="spectrolite-gem" aria-hidden>◆</span>
          <Heading size="6" align="center">Spectrolite</Heading>
          <Text size="2" color="gray" align="center" as="p" style={{ maxWidth: 420 }}>
            A live MDX knowledge base with a resident editing agent
            {agentHandle ? <> — <Text weight="medium">@{agentHandle}</Text> is already in the room.</> : null}
            {" "}Each vault is a workspace VCS folder under <Code>projects/</Code>.
          </Text>
        </Flex>

        <Card size="2">
          <Flex direction="column" gap="2">
            <Flex align="center" justify="between">
              <Text size="2" weight="bold">Open a vault</Text>
              <IconButton size="1" variant="ghost" color="gray" onClick={() => setRefreshNonce((n) => n + 1)} aria-label="Refresh vault list">
                <ReloadIcon />
              </IconButton>
            </Flex>
            {vaults === null ? (
              <Flex align="center" gap="2" py="2"><Spinner /> <Text size="1" color="gray">Scanning workspace…</Text></Flex>
            ) : vaults.length === 0 ? (
              <Text size="1" color="gray">
                {discoverError ? `Could not scan the workspace: ${discoverError}` : "No vaults yet. Create one below."}
              </Text>
            ) : (
              <Flex direction="column" gap="1">
                {vaults.map((v) => (
                  <button
                    key={v.relPath}
                    type="button"
                    className="spectrolite-vault-row"
                    onClick={() => onSelect(v.contextPath)}
                    data-testid={`spectrolite-vault-${v.name}`}
                  >
                    <span className="spectrolite-vault-icon"><ArchiveIcon /></span>
                    <Box style={{ flex: 1, textAlign: "left", minWidth: 0 }}>
                      <Text size="2" weight="medium" as="div" truncate>{v.name}</Text>
                      <Text size="1" color="gray" as="div" truncate>
                        {v.relPath}
                      </Text>
                    </Box>
                  </button>
                ))}
              </Flex>
            )}
          </Flex>
        </Card>

        <Card size="2">
          <Flex direction="column" gap="2">
            <Text size="2" weight="bold">Create a new vault</Text>
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
                Will be created at <Code>projects/{newName.trim() || "<name>"}</Code> with a starter <Code>Welcome.mdx</Code>.
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
