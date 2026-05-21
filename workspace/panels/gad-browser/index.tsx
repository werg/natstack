import { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { Box, Button, Flex, Grid, Heading, ScrollArea, Table, Tabs, Text, Theme } from "@radix-ui/themes";
import { ReloadIcon } from "@radix-ui/react-icons";
import { gad, useStateArgs } from "@workspace/runtime";
import { usePanelTheme } from "@workspace/react";

interface StateArgs {
  branchId?: string;
}

type Row = Record<string, unknown>;

function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function DataTable({ rows, columns }: { rows: Row[]; columns: string[] }) {
  if (rows.length === 0) {
    return <Text color="gray" size="2">No rows</Text>;
  }
  return (
    <Table.Root size="1" variant="surface">
      <Table.Header>
        <Table.Row>
          {columns.map((column) => <Table.ColumnHeaderCell key={column}>{column}</Table.ColumnHeaderCell>)}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((row, index) => (
          <Table.Row key={index}>
            {columns.map((column) => (
              <Table.Cell key={column}>
                <Text size="1" style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>
                  {asText(row[column])}
                </Text>
              </Table.Cell>
            ))}
          </Table.Row>
        ))}
      </Table.Body>
    </Table.Root>
  );
}

function App() {
  const appearance = usePanelTheme();
  const stateArgs = useStateArgs<StateArgs>();
  const [branches, setBranches] = useState<Row[]>([]);
  const [selectedBranchId, setSelectedBranchId] = useState<string | null>(stateArgs.branchId ?? null);
  const [events, setEvents] = useState<Row[]>([]);
  const [envelopes, setEnvelopes] = useState<Row[]>([]);
  const [files, setFiles] = useState<Row[]>([]);
  const [invocations, setInvocations] = useState<Row[]>([]);
  const [status, setStatus] = useState<Row[]>([]);
  const [integrity, setIntegrity] = useState<Row[]>([]);
  const [operationStatus, setOperationStatus] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const selectedBranch = useMemo(
    () => branches.find((branch) => asText(branch["branch_id"]) === selectedBranchId) ?? null,
    [branches, selectedBranchId],
  );

  async function refresh() {
    setLoading(true);
    try {
      const [nextStatus, nextBranches] = await Promise.all([
        gad.status(),
        gad.query("SELECT * FROM trajectory_branches ORDER BY updated_at DESC"),
      ]);
      setStatus(nextStatus as unknown as Row[]);
      setBranches(nextBranches.rows);
      const branchId = (selectedBranchId ?? asText(nextBranches.rows[0]?.["branch_id"])) || null;
      setSelectedBranchId(branchId);
      if (branchId) {
        const [nextEvents, nextFiles, nextInvocations, nextEnvelopes] = await Promise.all([
          gad.listTrajectoryEvents({ branchId, limit: 200 }),
          gad.listGadBranchFiles({ branchId }),
          gad.query("SELECT * FROM trajectory_invocations WHERE branch_id = ? ORDER BY updated_at DESC", [branchId]),
          gad.query("SELECT * FROM channel_envelopes ORDER BY channel_id, seq LIMIT 200"),
        ]);
        setEvents(nextEvents as unknown as Row[]);
        setFiles(nextFiles);
        setInvocations(nextInvocations.rows);
        setEnvelopes(nextEnvelopes.rows);
      } else {
        setEvents([]);
        setFiles([]);
        setInvocations([]);
        setEnvelopes([]);
      }
    } finally {
      setLoading(false);
    }
  }

  async function checkIntegrity() {
    setLoading(true);
    try {
      const result = await gad.checkGadIntegrity({});
      setIntegrity(result.errors);
      setOperationStatus(result.ok ? "Integrity OK" : `${result.errors.length} integrity issue(s)`);
    } finally {
      setLoading(false);
    }
  }

  async function validateHashes() {
    setLoading(true);
    try {
      const result = await gad.validateGadHashes({});
      setIntegrity(result.errors.map((message) => ({ message })));
      setOperationStatus(result.ok ? "Hashes OK" : `${result.errors.length} hash issue(s)`);
    } finally {
      setLoading(false);
    }
  }

  async function replayEvents() {
    setLoading(true);
    try {
      const result = await gad.rebuildTrajectoryProjections({});
      setOperationStatus(`Replayed ${result.replayed} event(s)`);
      await refresh();
      await checkIntegrity();
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => {
    if (!selectedBranchId) return;
    void Promise.all([
      gad.listTrajectoryEvents({ branchId: selectedBranchId, limit: 200 }).then((rows) => setEvents(rows as unknown as Row[])),
      gad.listGadBranchFiles({ branchId: selectedBranchId }).then(setFiles),
      gad.query("SELECT * FROM trajectory_invocations WHERE branch_id = ? ORDER BY updated_at DESC", [selectedBranchId]).then((result) => setInvocations(result.rows)),
      gad.query("SELECT * FROM channel_envelopes ORDER BY channel_id, seq LIMIT 200").then((result) => setEnvelopes(result.rows)),
    ]);
  }, [selectedBranchId]);

  return (
    <Theme appearance={appearance}>
      <Box p="4" style={{ height: "100vh", boxSizing: "border-box" }}>
        <Flex direction="column" gap="3" height="100%">
          <Flex align="center" justify="between" gap="3">
            <Box>
              <Heading size="4">gad Browser</Heading>
              <Text color="gray" size="2">{selectedBranch ? asText(selectedBranch["name"]) : "Workspace provenance"}</Text>
            </Box>
            <Flex align="center" gap="2" wrap="wrap" justify="end">
              {operationStatus ? <Text color="gray" size="2">{operationStatus}</Text> : null}
              <Button size="2" variant="soft" onClick={() => void checkIntegrity()} disabled={loading}>
                Check Integrity
              </Button>
              <Button size="2" variant="soft" onClick={() => void validateHashes()} disabled={loading}>
                Validate Hashes
              </Button>
              <Button size="2" variant="soft" onClick={() => void replayEvents()} disabled={loading}>
                Replay
              </Button>
              <Button size="2" variant="soft" onClick={() => void refresh()} disabled={loading} title="Refresh">
                <ReloadIcon /> Refresh
              </Button>
            </Flex>
          </Flex>

          <Grid columns={{ initial: "1", md: "260px 1fr" }} gap="3" style={{ minHeight: 0, flex: 1 }}>
            <ScrollArea type="auto" scrollbars="vertical">
              <Flex direction="column" gap="2" pr="2">
                {branches.map((branch) => {
                  const id = asText(branch["branch_id"]);
                  return (
                    <Button
                      key={id}
                      variant={id === selectedBranchId ? "solid" : "soft"}
                      color={id === selectedBranchId ? "blue" : "gray"}
                      onClick={() => setSelectedBranchId(id)}
                      style={{ justifyContent: "flex-start" }}
                    >
                      {asText(branch["name"] || branch["branch_id"])}
                    </Button>
                  );
                })}
              </Flex>
            </ScrollArea>

            <Tabs.Root defaultValue="files" style={{ minWidth: 0 }}>
              <Tabs.List>
                <Tabs.Trigger value="branches">Branches</Tabs.Trigger>
                <Tabs.Trigger value="events">Trajectory Events</Tabs.Trigger>
                <Tabs.Trigger value="envelopes">Channel Envelopes</Tabs.Trigger>
                <Tabs.Trigger value="files">Files</Tabs.Trigger>
                <Tabs.Trigger value="invocations">Invocations</Tabs.Trigger>
                <Tabs.Trigger value="integrity">Integrity</Tabs.Trigger>
                <Tabs.Trigger value="status">Status</Tabs.Trigger>
              </Tabs.List>
              <Box pt="3" style={{ height: "calc(100vh - 130px)" }}>
                <ScrollArea type="auto" scrollbars="both" style={{ height: "100%" }}>
                  <Tabs.Content value="branches">
                    <DataTable rows={branches} columns={["trajectory_id", "branch_id", "head_event_id", "head_event_hash", "head_state_hash", "updated_at"]} />
                  </Tabs.Content>
                  <Tabs.Content value="events">
                    <DataTable rows={events} columns={["seq", "eventId", "eventHash", "prevEventHash", "kind", "turnId", "createdAt"]} />
                  </Tabs.Content>
                  <Tabs.Content value="envelopes">
                    <DataTable rows={envelopes} columns={["channel_id", "seq", "envelope_id", "payload_kind", "published_at"]} />
                  </Tabs.Content>
                  <Tabs.Content value="files">
                    <DataTable rows={files} columns={["path", "content_hash", "mode", "file_version_id"]} />
                  </Tabs.Content>
                  <Tabs.Content value="invocations">
                    <DataTable rows={invocations} columns={["invocation_id", "kind", "status", "started_event_id", "completed_event_id", "updated_at"]} />
                  </Tabs.Content>
                  <Tabs.Content value="integrity">
                    <DataTable rows={integrity} columns={["type", "message", "entryId", "eventId", "stateHash", "manifestRootHash"]} />
                  </Tabs.Content>
                  <Tabs.Content value="status">
                    <DataTable rows={status} columns={["metric", "value"]} />
                  </Tabs.Content>
                </ScrollArea>
              </Box>
            </Tabs.Root>
          </Grid>
        </Flex>
      </Box>
    </Theme>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
