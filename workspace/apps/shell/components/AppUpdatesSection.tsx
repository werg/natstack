import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Badge, Button, Callout, Code, Flex, Table, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { app, notification, workspaceUnits } from "../shell/client";
import { useShellEvent } from "../shell/useShellEvent";

type PendingUpdate = Awaited<ReturnType<typeof app.listPendingUpdates>>[number];
type WorkspaceUnit = Awaited<ReturnType<typeof workspaceUnits.list>>[number];
type WorkspaceUnitLog = Awaited<ReturnType<typeof workspaceUnits.logs>>[number];

export function AppUpdatesSection() {
  const [pending, setPending] = useState<PendingUpdate[]>([]);
  const [apps, setApps] = useState<WorkspaceUnit[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedLogs, setExpandedLogs] = useState<Record<string, WorkspaceUnitLog[]>>({});

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

  useShellEvent(
    "apps:available",
    useCallback(() => {
      void load();
    }, [load])
  );
  useShellEvent(
    "apps:status",
    useCallback(() => {
      void load();
    }, [load])
  );
  useShellEvent(
    "apps:lifecycle",
    useCallback(() => {
      void load();
    }, [load])
  );

  const pendingByApp = useMemo(
    () => new Map(pending.map((update) => [update.appId, update])),
    [pending]
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
        message: buildKey
          ? `${appId} restored ${shortBuild(buildKey)}.`
          : `${appId} restored the previous build.`,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const restart = async (appId: string) => {
    setBusy(`restart:${appId}`);
    try {
      setError(null);
      await workspaceUnits.restart(appId);
      await load();
      await loadLogs(appId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const loadLogs = async (appId: string) => {
    setBusy(`logs:${appId}`);
    try {
      setError(null);
      const rows = await workspaceUnits.logs(appId, { limit: 80 });
      setExpandedLogs((current) => ({ ...current, [appId]: rows }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const toggleLogs = async (appId: string) => {
    if (expandedLogs[appId]) {
      setExpandedLogs((current) => {
        const next = { ...current };
        delete next[appId];
        return next;
      });
      return;
    }
    await loadLogs(appId);
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
            const logs = expandedLogs[unit.name];
            return (
              <Fragment key={unit.name}>
                <Table.Row>
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
                        {unit.previousVersions?.length ?? 0}/{unit.rollbackRetentionLimit ?? 5}{" "}
                        retained
                      </Text>
                      {latestPrevious ? (
                        <Code size="1">{shortBuild(latestPrevious.activeBundleKey)}</Code>
                      ) : null}
                    </Flex>
                  </Table.Cell>
                  <Table.Cell>
                    <Flex gap="1" justify="end" wrap="wrap">
                      {pendingUpdate ? (
                        <Button
                          size="1"
                          disabled={busy === `apply:${unit.name}`}
                          onClick={() => void loadUpdate(unit.name)}
                        >
                          Load
                        </Button>
                      ) : null}
                      {unit.target === "terminal" ? (
                        <>
                          <Button
                            size="1"
                            variant="soft"
                            disabled={busy === `restart:${unit.name}` || !unit.activeBundleKey}
                            onClick={() => void restart(unit.name)}
                          >
                            {unit.status === "running" ? "Restart" : "Start"}
                          </Button>
                          <Button
                            size="1"
                            variant="ghost"
                            disabled={busy === `logs:${unit.name}`}
                            onClick={() => void toggleLogs(unit.name)}
                          >
                            Logs
                          </Button>
                        </>
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
                {logs ? (
                  <Table.Row key={`${unit.name}:logs`}>
                    <Table.Cell colSpan={6}>
                      <Flex direction="column" gap="1">
                        {logs.length === 0 ? (
                          <Text size="1" color="gray">
                            No logs
                          </Text>
                        ) : (
                          logs.map((row) => (
                            <Text
                              as="div"
                              size="1"
                              color={row.level === "error" ? "red" : "gray"}
                              key={`${row.timestamp}:${row.source ?? ""}:${row.message}`}
                            >
                              <Code size="1">{row.level}</Code>{" "}
                              {row.source ? <Code size="1">{row.source}</Code> : null} {row.message}
                            </Text>
                          ))
                        )}
                      </Flex>
                    </Table.Cell>
                  </Table.Row>
                ) : null}
              </Fragment>
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
  const suffix = [phase, target]
    .filter((value): value is string => typeof value === "string")
    .join(", ");
  return suffix ? `${message} (${suffix})` : message;
}
