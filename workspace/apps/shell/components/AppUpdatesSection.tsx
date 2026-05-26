import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Callout, Code, Flex, Table, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { app, notification, workspaceUnits } from "../shell/client";
import { useShellEvent } from "../shell/useShellEvent";

type PendingUpdate = Awaited<ReturnType<typeof app.listPendingUpdates>>[number];
type WorkspaceUnit = Awaited<ReturnType<typeof workspaceUnits.list>>[number];

export function AppUpdatesSection() {
  const [pending, setPending] = useState<PendingUpdate[]>([]);
  const [apps, setApps] = useState<WorkspaceUnit[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setError(null);
      const [pendingUpdates, units] = await Promise.all([
        app.listPendingUpdates(),
        workspaceUnits.list(),
      ]);
      setPending(pendingUpdates);
      setApps(units.filter((unit) => unit.kind === "app"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useShellEvent("apps:available", useCallback(() => {
    void load();
  }, [load]));
  useShellEvent("apps:status", useCallback(() => {
    void load();
  }, [load]));
  useShellEvent("apps:lifecycle", useCallback(() => {
    void load();
  }, [load]));

  const pendingByApp = useMemo(
    () => new Map(pending.map((update) => [update.appId, update])),
    [pending],
  );

  const loadUpdate = async (appId: string) => {
    setBusy(`apply:${appId}`);
    try {
      setError(null);
      const result = await app.applyUpdate(appId);
      if (!result.applied) setError(`${appId} has no pending desktop update.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const rollback = async (appId: string, buildKey?: string) => {
    setBusy(`rollback:${appId}:${buildKey ?? "latest"}`);
    try {
      setError(null);
      await workspaceUnits.rollback(appId, { buildKey });
      await load();
      void notification.show({
        type: "success",
        title: "App rolled back",
        message: buildKey ? `${appId} restored ${shortBuild(buildKey)}.` : `${appId} restored the previous build.`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  if (apps.length === 0) return null;

  return (
    <Flex direction="column" gap="2" mt="4">
      <Flex justify="between" align="center">
        <Text size="2" weight="medium">
          App updates
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
      <Table.Root size="1" variant="surface">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>App</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Target</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Status</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Active build</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Rollback</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell />
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {apps.map((unit) => {
            const pendingUpdate = pendingByApp.get(unit.name);
            const latestPrevious = unit.previousVersions?.[0];
            return (
              <Table.Row key={unit.name}>
                <Table.Cell>
                  <Flex direction="column" gap="1">
                    <Text size="2">{unit.displayName ?? unit.name}</Text>
                    <Code size="1">{unit.source}</Code>
                  </Flex>
                </Table.Cell>
                <Table.Cell>{unit.target ?? "unknown"}</Table.Cell>
                <Table.Cell>
                  <Flex direction="column" gap="1">
                    <Badge color={statusColor(unit.status)}>{unit.status}</Badge>
                    {pendingUpdate ? <Badge color="blue">pending desktop update</Badge> : null}
                    {unit.lastError ? (
                      <Text size="1" color="red">
                        {formatError(unit.lastError, unit.lastErrorDetails)}
                      </Text>
                    ) : null}
                  </Flex>
                </Table.Cell>
                <Table.Cell>
                  <Code size="1">{shortBuild(unit.activeBundleKey)}</Code>
                </Table.Cell>
                <Table.Cell>
                  <Flex direction="column" gap="1">
                    <Text size="1" color="gray">
                      {unit.previousVersions?.length ?? 0}/{unit.rollbackRetentionLimit ?? 5} retained
                    </Text>
                    {latestPrevious ? (
                      <Code size="1">{shortBuild(latestPrevious.activeBundleKey)}</Code>
                    ) : null}
                  </Flex>
                </Table.Cell>
                <Table.Cell>
                  <Flex gap="1" justify="end">
                    {pendingUpdate ? (
                      <Button
                        size="1"
                        disabled={busy === `apply:${unit.name}`}
                        onClick={() => void loadUpdate(unit.name)}
                      >
                        Load
                      </Button>
                    ) : null}
                    {latestPrevious ? (
                      <Button
                        size="1"
                        variant="soft"
                        disabled={busy?.startsWith(`rollback:${unit.name}:`) ?? false}
                        onClick={() => void rollback(unit.name)}
                      >
                        Roll back
                      </Button>
                    ) : null}
                  </Flex>
                </Table.Cell>
              </Table.Row>
            );
          })}
        </Table.Body>
      </Table.Root>
    </Flex>
  );
}

function shortBuild(value: string | null | undefined): string {
  if (!value) return "none";
  return value.length > 12 ? value.slice(0, 12) : value;
}

function statusColor(status: string): "green" | "red" | "amber" | "blue" | "gray" {
  if (status === "running" || status === "available") return "green";
  if (status === "error") return "red";
  if (status === "pending-approval") return "amber";
  if (status === "building") return "blue";
  return "gray";
}

function formatError(message: string, details: unknown): string {
  if (!details || typeof details !== "object") return message;
  const phase = (details as { phase?: unknown }).phase;
  const target = (details as { target?: unknown }).target;
  const suffix = [phase, target].filter((value): value is string => typeof value === "string").join(", ");
  return suffix ? `${message} (${suffix})` : message;
}
