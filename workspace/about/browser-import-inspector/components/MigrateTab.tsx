import { useCallback, useState } from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Checkbox,
  Flex,
  Grid,
  Heading,
  Separator,
  Spinner,
  Table,
  Text,
} from "@radix-ui/themes";
import {
  InfoCircledIcon,
  DownloadIcon,
  MagnifyingGlassIcon,
  OpenInNewWindowIcon,
} from "@radix-ui/react-icons";
import type {
  ImportedOpenTab,
  ImportResult,
  ImportRun,
  PreviewTypeResult,
} from "@workspace/panel-browser";
import { ProfileSelection } from "./BrowserProfileRail";
import { useAsync, browserData, relativeTime, DATA_TYPES, classifyError } from "../useBrowserData";

const DEFAULT_TYPES = ["bookmarks", "history", "cookies", "passwords", "searchEngines"];

export function MigrateTab(props: { selection: ProfileSelection; now: number }) {
  const { selection } = props;
  const browserName = selection.browser.name;
  const profilePath = selection.profile.path;
  const sel = `${browserName}::${profilePath}`;

  const [types, setTypes] = useState<Set<string>>(new Set(DEFAULT_TYPES));
  const [preview, setPreview] = useState<PreviewTypeResult[] | null>(null);
  const [importResult, setImportResult] = useState<ImportResult[] | null>(null);
  const [busy, setBusy] = useState<null | "preview" | "import">(null);
  const [error, setError] = useState<string | null>(null);

  // Reset transient state when the profile changes.
  const [lastSel, setLastSel] = useState(sel);
  if (lastSel !== sel) {
    setLastSel(sel);
    setPreview(null);
    setImportResult(null);
    setError(null);
    setTypes(new Set(DEFAULT_TYPES));
  }

  const runState = useAsync(
    () => browserData.getProfileImportState({ browser: browserName, profilePath }),
    [sel, importResult],
  );

  const request = useCallback(
    () => ({ browser: browserName, profile: profilePath, dataTypes: [...types] as never }),
    [browserName, profilePath, types],
  );

  const doPreview = useCallback(async () => {
    setBusy("preview");
    setError(null);
    try {
      setPreview(await browserData.previewImport(request()));
    } catch (err) {
      setError(classifyError(err).message);
    } finally {
      setBusy(null);
    }
  }, [request]);

  const doImport = useCallback(async () => {
    setBusy("import");
    setError(null);
    try {
      setImportResult(await browserData.startImport(request()));
      setPreview(null);
    } catch (err) {
      setError(classifyError(err).message);
    } finally {
      setBusy(null);
    }
  }, [request]);

  const toggle = (key: string) =>
    setTypes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <Flex direction="column" gap="4" p="4" style={{ overflowY: "auto", height: "100%" }}>
      <MigrationScorecard preview={preview} lastImport={runState.state.data?.lastRun} now={props.now} />

      {selection.browser.tccBlocked && (
        <Callout.Root color="amber">
          <Callout.Icon>
            <InfoCircledIcon />
          </Callout.Icon>
          <Callout.Text>
            {selection.browser.displayName} is blocked by the OS privacy layer (TCC). Grant full
            disk access to read this profile.
          </Callout.Text>
        </Callout.Root>
      )}

      <Card>
        <Heading size="2" mb="2">
          Import plan
        </Heading>
        <Grid columns="2" gap="1" mb="3">
          {DATA_TYPES.map((dt) => (
            <Text as="label" size="2" key={dt.key}>
              <Flex gap="2" align="center">
                <Checkbox checked={types.has(dt.key)} onCheckedChange={() => toggle(dt.key)} />
                {dt.label}
              </Flex>
            </Text>
          ))}
        </Grid>
        <Flex gap="2" align="center" wrap="wrap">
          <Button variant="soft" disabled={busy !== null || types.size === 0} onClick={doPreview}>
            {busy === "preview" ? <Spinner size="1" /> : <MagnifyingGlassIcon />} Preview (dry run)
          </Button>
          <Button disabled={busy !== null || types.size === 0} onClick={doImport}>
            {busy === "import" ? <Spinner size="1" /> : <DownloadIcon />} Pull latest
          </Button>
          <Text size="1" color="gray">
            Re-running is safe — incremental import never duplicates.
          </Text>
        </Flex>
        {error && (
          <Callout.Root color="red" mt="3">
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}
      </Card>

      {preview && <ImportDiffTable preview={preview} />}
      {importResult && <ImportResultCard results={importResult} />}

      <OpenTabsPreview selection={selection} />

      <ImportRunTimeline runs={runState.state.data?.runs ?? []} now={props.now} />
    </Flex>
  );
}

function MigrationScorecard(props: {
  preview: PreviewTypeResult[] | null;
  lastImport: ImportRun | null | undefined;
  now: number;
}) {
  const totals = (props.preview ?? []).reduce(
    (acc, p) => {
      acc.added += p.added;
      acc.changed += p.changed;
      acc.unchanged += p.unchanged;
      acc.skipped += p.skipped;
      return acc;
    },
    { added: 0, changed: 0, unchanged: 0, skipped: 0 },
  );
  const lastFinished = props.lastImport ? props.lastImport.finished_at : null;

  return (
    <Card>
      <Flex justify="between" align="center" mb="2">
        <Heading size="2">Migration scorecard</Heading>
        <Text size="1" color="gray">
          last import: {relativeTime(lastFinished, props.now)}
        </Text>
      </Flex>
      {props.preview ? (
        <Flex gap="4" wrap="wrap">
          <Stat label="New" value={totals.added} color="green" />
          <Stat label="Changed" value={totals.changed} color="amber" />
          <Stat label="Unchanged" value={totals.unchanged} color="gray" />
          <Stat label="Skipped" value={totals.skipped} color="red" />
        </Flex>
      ) : (
        <Text size="2" color="gray">
          Run a dry-run preview to see what would change since the last import.
        </Text>
      )}
    </Card>
  );
}

function Stat(props: { label: string; value: number; color: "green" | "amber" | "gray" | "red" }) {
  return (
    <Flex direction="column" align="center" minWidth="64px">
      <Text size="6" weight="bold" color={props.color}>
        {props.value}
      </Text>
      <Text size="1" color="gray">
        {props.label}
      </Text>
    </Flex>
  );
}

function ImportDiffTable(props: { preview: PreviewTypeResult[] }) {
  return (
    <Card>
      <Heading size="2" mb="2">
        Dry-run diff
      </Heading>
      <Table.Root size="1" variant="surface">
        <Table.Header>
          <Table.Row>
            <Table.ColumnHeaderCell>Type</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Scanned</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>New</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Changed</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Unchanged</Table.ColumnHeaderCell>
            <Table.ColumnHeaderCell>Skipped</Table.ColumnHeaderCell>
          </Table.Row>
        </Table.Header>
        <Table.Body>
          {props.preview.map((p) => (
            <Table.Row key={p.dataType}>
              <Table.RowHeaderCell>{p.dataType}</Table.RowHeaderCell>
              <Table.Cell>{p.scanned}</Table.Cell>
              <Table.Cell>
                {p.added > 0 ? <Badge color="green">{p.added}</Badge> : 0}
              </Table.Cell>
              <Table.Cell>
                {p.changed > 0 ? <Badge color="amber">{p.changed}</Badge> : 0}
              </Table.Cell>
              <Table.Cell>
                <Text color="gray">{p.unchanged}</Text>
              </Table.Cell>
              <Table.Cell>
                {p.skipped > 0 ? <Badge color="red">{p.skipped}</Badge> : 0}
              </Table.Cell>
            </Table.Row>
          ))}
        </Table.Body>
      </Table.Root>
      {props.preview.some((p) => p.samples.length > 0) && (
        <Box mt="3">
          <Text size="1" color="gray">
            Sample changes (values masked):
          </Text>
          <Flex direction="column" gap="1" mt="1">
            {props.preview.flatMap((p) =>
              p.samples.slice(0, 4).map((s, i) => (
                <Flex key={`${p.dataType}-${i}`} gap="2" align="center">
                  <Badge size="1" color={s.status === "added" ? "green" : s.status === "changed" ? "amber" : "red"}>
                    {s.status}
                  </Badge>
                  <Text size="1">{s.label}</Text>
                  {s.detail && (
                    <Text size="1" color="gray">
                      ({s.detail})
                    </Text>
                  )}
                </Flex>
              )),
            )}
          </Flex>
        </Box>
      )}
    </Card>
  );
}

function ImportResultCard(props: { results: ImportResult[] }) {
  return (
    <Card>
      <Heading size="2" mb="2">
        Import complete
      </Heading>
      <Flex direction="column" gap="1">
        {props.results.map((r) => (
          <Flex key={r.dataType} gap="2" align="center">
            <Badge color={r.success ? "green" : "red"} size="1">
              {r.dataType}
            </Badge>
            <Text size="1">
              {r.itemCount} stored{r.skippedCount > 0 ? `, ${r.skippedCount} skipped` : ""}
            </Text>
            {r.warnings.map((w, i) => (
              <Text key={i} size="1" color="amber">
                {w}
              </Text>
            ))}
          </Flex>
        ))}
      </Flex>
    </Card>
  );
}

function ImportRunTimeline(props: { runs: ImportRun[]; now: number }) {
  if (props.runs.length === 0) return null;
  const dataTypesOf = (run: ImportRun): string => {
    try {
      return (JSON.parse(run.data_types || "[]") as string[]).join(", ");
    } catch {
      return "";
    }
  };
  return (
    <Card>
      <Heading size="2" mb="2">
        Import history
      </Heading>
      <Flex direction="column" gap="2">
        {props.runs.map((run) => (
          <Box key={run.id}>
            <Flex gap="2" align="center">
              <Badge
                size="1"
                color={run.status === "success" ? "green" : run.status === "partial" ? "amber" : "red"}
              >
                {run.status}
              </Badge>
              <Text size="1" color="gray">
                {relativeTime(run.finished_at, props.now)}
              </Text>
              <Text size="1">{dataTypesOf(run)}</Text>
            </Flex>
          </Box>
        ))}
      </Flex>
    </Card>
  );
}

function OpenTabsPreview(props: { selection: ProfileSelection }) {
  const { selection } = props;
  const { state } = useAsync<ImportedOpenTab[]>(
    () => browserData.getOpenTabs({ browser: selection.browser.name, profile: selection.profile.path }),
    [selection.browser.name, selection.profile.path],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [opening, setOpening] = useState(false);
  const [opened, setOpened] = useState<number | null>(null);

  const tabKey = (t: ImportedOpenTab) => `${t.windowIndex}.${t.tabIndex}`;
  const tabs = state.data ?? [];
  const byWindow = new Map<number, ImportedOpenTab[]>();
  for (const t of tabs) {
    const arr = byWindow.get(t.windowIndex) ?? [];
    arr.push(t);
    byWindow.set(t.windowIndex, arr);
  }

  const openSelected = async () => {
    setOpening(true);
    setOpened(null);
    try {
      const selection2 = tabs
        .filter((t) => selected.has(tabKey(t)))
        .map((t) => ({ windowIndex: t.windowIndex, tabIndex: t.tabIndex }));
      const result = await browserData.openTabsAsPanels({
        browser: selection.browser.name,
        profile: selection.profile.path,
        ...(selection2.length > 0 ? { selection: selection2 } : {}),
      });
      setOpened(result.panelsOpened);
    } finally {
      setOpening(false);
    }
  };

  return (
    <Card>
      <Flex justify="between" align="center" mb="2">
        <Heading size="2">Open tabs</Heading>
        <Button
          size="1"
          variant="soft"
          disabled={opening || tabs.length === 0}
          onClick={openSelected}
        >
          {opening ? <Spinner size="1" /> : <OpenInNewWindowIcon />}{" "}
          {selected.size > 0 ? `Open ${selected.size} as panels` : "Open all as panels"}
        </Button>
      </Flex>
      <Callout.Root size="1" color="gray" mb="2">
        <Callout.Text>
          Opening tabs creates new child panels every time — unlike import, it is not incremental.
        </Callout.Text>
      </Callout.Root>
      {state.status === "loading" && <Spinner size="1" />}
      {selection.browser.family === "safari" && (
        <Text size="1" color="gray">
          Safari does not expose open tabs.
        </Text>
      )}
      {opened !== null && (
        <Text size="1" color="green">
          Opened {opened} panel(s).
        </Text>
      )}
      <Flex direction="column" gap="3" mt="2">
        {[...byWindow.entries()].map(([windowIndex, windowTabs]) => (
          <Box key={windowIndex}>
            <Text size="1" weight="bold" color="gray">
              Window {windowIndex + 1}
            </Text>
            <Flex direction="column" gap="1" mt="1">
              {windowTabs.map((t) => {
                const key = tabKey(t);
                return (
                  <Flex key={key} gap="2" align="center">
                    <Checkbox
                      checked={selected.has(key)}
                      onCheckedChange={() =>
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                    />
                    {t.active && (
                      <Badge size="1" color="green">
                        active
                      </Badge>
                    )}
                    {t.pinned && (
                      <Badge size="1" color="blue">
                        pinned
                      </Badge>
                    )}
                    <Text size="1" truncate style={{ maxWidth: 360 }}>
                      {t.title || t.url}
                    </Text>
                  </Flex>
                );
              })}
            </Flex>
          </Box>
        ))}
      </Flex>
      {tabs.length === 0 && state.status === "ready" && selection.browser.family !== "safari" && (
        <Text size="1" color="gray">
          No open tabs found in the session files.
        </Text>
      )}
      <Separator size="4" my="0" />
    </Card>
  );
}
