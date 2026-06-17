import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Callout, Code, Flex, Table, Text, TextField } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetLaunchSessionSnapshot,
  HostTargetSelection,
} from "@natstack/shared/hostTargets";
import type { PendingUnitBatchApproval } from "@natstack/shared/approvals";
import {
  formatCapabilities,
  launchCopy,
  plural,
  shortVersion,
  targetLabel,
  unitKindLabel,
  unitReviewRows,
  unitSourceLabel,
  unitSummaryChips,
} from "@natstack/shared/bootstrapLaunchGate";
import { workspace } from "../shell/client";

const HOST_TARGETS: HostTarget[] = ["electron", "react-native", "terminal"];

type SelectionState = Record<
  HostTarget,
  { selection: HostTargetSelection | null; valid: boolean; reason?: string }
>;

function launchSessionMessage(session: HostTargetLaunchSessionSnapshot): string {
  return [session.message, session.detail].filter(Boolean).join(" ");
}

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
  const [pinnedRefs, setPinnedRefs] = useState<Record<string, string>>({});
  const [pendingApproval, setPendingApproval] = useState<{
    target: HostTarget;
    session: HostTargetLaunchSessionSnapshot;
    approvals: PendingUnitBatchApproval[];
  } | null>(null);
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

  const pinRef = async (target: HostTarget, candidate: HostTargetCandidate) => {
    const ref = pinnedRefs[`${target}:${candidate.name}`]?.trim();
    if (!ref) return;
    setBusy(`${target}:${candidate.name}:ref`);
    try {
      setError(null);
      const prepared = (await workspace.hostTargets.preparePinnedRef(
        target,
        candidate.source,
        ref
      )) as { buildKey?: string };
      if (!prepared.buildKey) throw new Error("Pinned ref build did not return a build key");
      await workspace.hostTargets.setSelection(target, {
        source: candidate.source,
        mode: "pinned-ref",
        ref,
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
      setPendingApproval(null);
      const session = await workspace.hostTargets.beginLaunch(target);
      if (session.status === "approval-required") {
        setPendingApproval({ target, session, approvals: session.approvals });
        setError(
          `Review and approve the pending ${targetLabel(
            target
          ).toLowerCase()} app request to continue.`
        );
      } else if (session.status === "unavailable" || session.status === "preparing") {
        setError(launchSessionMessage(session));
      } else if (session.status === "denied") {
        setError(`${targetLabel(target)} app startup was denied.`);
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const resolvePendingApproval = async (decision: "once" | "deny") => {
    if (!pendingApproval) return;
    const target = pendingApproval.target;
    setBusy(`${target}:approval:${decision}`);
    try {
      setError(null);
      const session = await workspace.hostTargets.resolveLaunchSessionApproval(
        pendingApproval.session.sessionId,
        decision
      );
      if (decision === "deny") {
        setPendingApproval(null);
        setError(`${targetLabel(target)} app startup was denied.`);
        await load();
        return;
      }
      if (session.status === "approval-required") {
        setPendingApproval({ target, session, approvals: session.approvals });
        setError(`Another ${targetLabel(target).toLowerCase()} startup approval is pending.`);
      } else {
        setPendingApproval(null);
        if (session.status === "unavailable" || session.status === "preparing") {
          setError(launchSessionMessage(session));
        }
      }
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
      {pendingApproval ? (
        <Callout.Root size="1" color="amber">
          <Callout.Icon>
            <ExclamationTriangleIcon />
          </Callout.Icon>
          <Callout.Text>
            <Flex direction="column" gap="2">
              <Text size="2" weight="medium">
                {targetLabel(pendingApproval.target)} startup needs approval
              </Text>
              {pendingApproval.approvals.map((approval) => (
                <Flex key={approval.approvalId} direction="column" gap="2">
                  <Flex direction="column" gap="1">
                    <Text size="2" weight="medium">
                      {launchCopy(approval).title}
                    </Text>
                    <Text size="1" color="gray">
                      {launchCopy(approval).summary}
                    </Text>
                  </Flex>
                  <Flex gap="2" wrap="wrap" align="center">
                    <Badge size="1" color="amber">
                      {plural(approval.units.length, "privileged unit")}
                    </Badge>
                    {unitSummaryChips(approval).map((chip) => (
                      <Badge key={chip} size="1" variant="soft">
                        {chip}
                      </Badge>
                    ))}
                  </Flex>
                  <details>
                    <summary>
                      <Text size="1" weight="medium">
                        Review details
                      </Text>
                      <Text size="1" color="gray">
                        {" "}
                        sources, versions, capabilities
                      </Text>
                    </summary>
                    <Flex direction="column" gap="1" mt="1">
                      {approval.units.map((unit, index) => {
                        const row = unitReviewRows(approval)[index]!;
                        return (
                          <Flex
                            key={`${approval.approvalId}:${unit.unitName}`}
                            direction="column"
                            gap="1"
                          >
                            <Flex gap="2" wrap="wrap" align="center">
                              <Text size="1" weight="medium">
                                {row.name}
                              </Text>
                              <Badge size="1">{unitKindLabel(unit)}</Badge>
                            </Flex>
                            <Code size="1">{unitSourceLabel(unit)}</Code>
                            <Text size="1" color="gray">
                              {formatCapabilities(unit)}
                            </Text>
                          </Flex>
                        );
                      })}
                    </Flex>
                  </details>
                </Flex>
              ))}
              <Flex gap="2">
                <Button
                  size="1"
                  disabled={busy === `${pendingApproval.target}:approval:once`}
                  onClick={() => void resolvePendingApproval("once")}
                >
                  Trust and start
                </Button>
                <Button
                  size="1"
                  color="red"
                  variant="soft"
                  disabled={busy === `${pendingApproval.target}:approval:deny`}
                  onClick={() => void resolvePendingApproval("deny")}
                >
                  Deny
                </Button>
              </Flex>
            </Flex>
          </Callout.Text>
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
              {(() => {
                const launchBusy = busy === `${target}:launch`;
                return (
                  <Button
                    size="1"
                    variant="soft"
                    disabled={launchBusy}
                    onClick={() => void launch(target)}
                  >
                    {launchBusy
                      ? target === "terminal"
                        ? "Starting..."
                        : "Launching..."
                      : target === "terminal"
                        ? "Start"
                        : "Launch"}
                  </Button>
                );
              })()}
            </Flex>
            <Table.Root size="1" variant="surface">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>App</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Build</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Ref</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {candidates[target].map((candidate) => {
                  const key = `${target}:${candidate.name}`;
                  const selected =
                    selections[target].selection?.appId === candidate.name ||
                    selections[target].selection?.source === candidate.source;
                  const selection = selected ? selections[target].selection : null;
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
                            {selection?.mode && selection.mode !== "follow-ref" ? (
                              <Badge color="amber">{selection.mode}</Badge>
                            ) : null}
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
                          <Code size="1">{shortVersion(candidate.activeBundleKey)}</Code>
                          {candidate.activeBundleKey ? (
                            <Button
                              size="1"
                              variant="ghost"
                              disabled={
                                busy ===
                                `${target}:${candidate.name}:pin:${candidate.activeBundleKey}`
                              }
                              onClick={() =>
                                void pinBuild(target, candidate, candidate.activeBundleKey!)
                              }
                            >
                              Pin current
                            </Button>
                          ) : null}
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
                          value={pinnedRefs[key] ?? ""}
                          placeholder="state:<hash> or ctx:<id>"
                          onChange={(event) =>
                            setPinnedRefs((current) => ({
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
                            {selection?.mode && selection.mode !== "follow-ref"
                              ? "Follow latest"
                              : "Select"}
                          </Button>
                          <Button
                            size="1"
                            variant="soft"
                            disabled={
                              !candidate.compatibility.selectable ||
                              !pinnedRefs[key]?.trim() ||
                              busy === `${target}:${candidate.name}:ref`
                            }
                            onClick={() => void pinRef(target, candidate)}
                          >
                            Build ref
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

function statusColor(status: string): "gray" | "blue" | "green" | "amber" | "red" {
  if (status === "running") return "green";
  if (status === "available") return "blue";
  if (status === "building" || status === "pending-approval") return "amber";
  if (status === "error") return "red";
  return "gray";
}
