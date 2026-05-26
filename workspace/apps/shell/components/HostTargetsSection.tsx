import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Callout, Code, Flex, Table, Text, TextField } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetSelection,
} from "@natstack/shared/hostTargets";
import { workspace } from "../shell/client";

const HOST_TARGETS: HostTarget[] = ["electron", "react-native", "terminal"];

type SelectionState = Record<
  HostTarget,
  { selection: HostTargetSelection | null; valid: boolean; reason?: string }
>;

export function HostTargetsSection() {
  const [candidates, setCandidates] = useState<Record<HostTarget, HostTargetCandidate[]>>({
    electron: [],
    "react-native": [],
    terminal: [],
  });
  const [selections, setSelections] = useState<SelectionState>({
    electron: { selection: null, valid: false },
    "react-native": { selection: null, valid: false },
    terminal: { selection: null, valid: false },
  });
  const [commitRefs, setCommitRefs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const loadedCandidates = await Promise.all(
        HOST_TARGETS.map(
          async (target) => [target, await workspace.hostTargets.list(target)] as const
        )
      );
      const loadedSelections = await Promise.all(
        HOST_TARGETS.map(
          async (target) => [target, await workspace.hostTargets.getSelection(target)] as const
        )
      );
      setCandidates(
        Object.fromEntries(loadedCandidates) as Record<HostTarget, HostTargetCandidate[]>
      );
      setSelections(Object.fromEntries(loadedSelections) as SelectionState);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const hasCandidates = useMemo(
    () => HOST_TARGETS.some((target) => candidates[target].length > 0),
    [candidates]
  );

  const selectCandidate = async (target: HostTarget, candidate: HostTargetCandidate) => {
    setBusy(`${target}:${candidate.name}:select`);
    try {
      setError(null);
      await workspace.hostTargets.setSelection(target, {
        source: candidate.source,
        mode: "follow-ref",
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const pinBuild = async (target: HostTarget, candidate: HostTargetCandidate, buildKey: string) => {
    setBusy(`${target}:${candidate.name}:pin:${buildKey}`);
    try {
      setError(null);
      await workspace.hostTargets.setSelection(target, {
        source: candidate.source,
        mode: "pinned-build",
        buildKey,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const pinCommit = async (target: HostTarget, candidate: HostTargetCandidate) => {
    const commit = commitRefs[`${target}:${candidate.name}`]?.trim();
    if (!commit) return;
    setBusy(`${target}:${candidate.name}:commit`);
    try {
      setError(null);
      const prepared = (await workspace.hostTargets.preparePinnedCommit(
        target,
        candidate.source,
        commit
      )) as { buildKey?: string };
      if (!prepared.buildKey) throw new Error("Pinned commit build did not return a build key");
      await workspace.hostTargets.setSelection(target, {
        source: candidate.source,
        mode: "pinned-commit",
        commit,
        buildKey: prepared.buildKey,
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const launch = async (target: HostTarget) => {
    setBusy(`${target}:launch`);
    try {
      setError(null);
      const result = await workspace.hostTargets.launch(target);
      if (!result.launched) setError(`No launchable ${target} app is selected.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (!hasCandidates) return null;

  return (
    <Flex direction="column" gap="2" mt="4">
      <Flex justify="between" align="center">
        <Text size="2" weight="medium">
          Host targets
        </Text>
        <Button size="1" variant="soft" onClick={() => void load()}>
          Refresh
        </Button>
      </Flex>
      {error ? (
        <Callout.Root size="1" color="amber">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      ) : null}
      {HOST_TARGETS.map((target) =>
        candidates[target].length > 0 ? (
          <Flex key={target} direction="column" gap="2">
            <Flex align="center" justify="between">
              <Flex align="center" gap="2">
                <Text size="2">{targetLabel(target)}</Text>
                {selections[target].valid && selections[target].selection ? (
                  <Badge color="green">{selections[target].selection.source}</Badge>
                ) : selections[target].reason ? (
                  <Badge color="amber">{selections[target].reason}</Badge>
                ) : null}
              </Flex>
              <Button
                size="1"
                variant="soft"
                disabled={busy === `${target}:launch`}
                onClick={() => void launch(target)}
              >
                Launch
              </Button>
            </Flex>
            <Table.Root size="1" variant="surface">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>App</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Build</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Commit/ref</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {candidates[target].map((candidate) => {
                  const key = `${target}:${candidate.name}`;
                  const selected =
                    selections[target].selection?.appId === candidate.name ||
                    selections[target].selection?.source === candidate.source;
                  const latestPrevious = candidate.previousVersions[0] as
                    | { activeBundleKey?: string }
                    | undefined;
                  return (
                    <Table.Row key={candidate.name}>
                      <Table.Cell>
                        <Flex direction="column" gap="1">
                          <Flex gap="1" align="center">
                            <Text size="2">{candidate.displayName ?? candidate.name}</Text>
                            {selected ? <Badge color="green">selected</Badge> : null}
                            {candidate.declared ? <Badge color="blue">declared</Badge> : null}
                          </Flex>
                          <Code size="1">{candidate.source}</Code>
                          {!candidate.compatibility.selectable ? (
                            <Text size="1" color="amber">
                              {candidate.compatibility.reasons.join("; ")}
                            </Text>
                          ) : null}
                        </Flex>
                      </Table.Cell>
                      <Table.Cell>
                        <Badge color={statusColor(candidate.status)}>{candidate.status}</Badge>
                      </Table.Cell>
                      <Table.Cell>
                        <Flex direction="column" gap="1">
                          <Code size="1">{shortBuild(candidate.activeBundleKey)}</Code>
                          {latestPrevious?.activeBundleKey ? (
                            <Button
                              size="1"
                              variant="soft"
                              disabled={
                                busy ===
                                `${target}:${candidate.name}:pin:${latestPrevious.activeBundleKey}`
                              }
                              onClick={() =>
                                void pinBuild(target, candidate, latestPrevious.activeBundleKey!)
                              }
                            >
                              Pin previous
                            </Button>
                          ) : null}
                        </Flex>
                      </Table.Cell>
                      <Table.Cell>
                        <TextField.Root
                          size="1"
                          value={commitRefs[key] ?? ""}
                          placeholder="commit or ref"
                          onChange={(event) =>
                            setCommitRefs((current) => ({
                              ...current,
                              [key]: event.target.value,
                            }))
                          }
                        />
                      </Table.Cell>
                      <Table.Cell>
                        <Flex gap="1" justify="end">
                          <Button
                            size="1"
                            disabled={
                              !candidate.compatibility.selectable ||
                              busy === `${target}:${candidate.name}:select`
                            }
                            onClick={() => void selectCandidate(target, candidate)}
                          >
                            Select
                          </Button>
                          <Button
                            size="1"
                            variant="soft"
                            disabled={
                              !candidate.compatibility.selectable ||
                              !commitRefs[key]?.trim() ||
                              busy === `${target}:${candidate.name}:commit`
                            }
                            onClick={() => void pinCommit(target, candidate)}
                          >
                            Build
                          </Button>
                        </Flex>
                      </Table.Cell>
                    </Table.Row>
                  );
                })}
              </Table.Body>
            </Table.Root>
          </Flex>
        ) : null
      )}
    </Flex>
  );
}

function targetLabel(target: HostTarget): string {
  if (target === "react-native") return "Mobile";
  if (target === "terminal") return "Terminal";
  return "Desktop";
}

function shortBuild(value?: string | null): string {
  if (!value) return "none";
  return value.length <= 12 ? value : value.slice(0, 12);
}

function statusColor(status: string): "gray" | "blue" | "green" | "amber" | "red" {
  if (status === "running") return "green";
  if (status === "available") return "blue";
  if (status === "building" || status === "pending-approval") return "amber";
  if (status === "error") return "red";
  return "gray";
}
