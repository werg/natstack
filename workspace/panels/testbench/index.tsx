/**
 * Testbench — in-system test runner, supervision and profiling UI.
 *
 * Tabs:
 *  - Suites: browse @workspace/testkit suites, run with live per-test status
 *  - History: saved runs from /.testkit/runs/ with pass/fail comparison
 *  - Profiles: artifacts from /.testkit/profiles/ with an inline flamegraph
 *
 * Also exposes RPC methods (runSuites/lastRun) so agents can drive the panel
 * itself via panelTree handles.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Code,
  Flex,
  Heading,
  ScrollArea,
  Switch,
  Tabs,
  Text,
  Theme,
} from "@radix-ui/themes";
import { PlayIcon, ReloadIcon } from "@radix-ui/react-icons";
import { rpc } from "@workspace/runtime";

// Top-level `expose` was removed from @workspace/runtime; this is the same
// arg-spreading wrapper over the portable `rpc.expose`, kept local to the panel.
const expose = (method: string, handler: (...args: any[]) => unknown | Promise<unknown>) =>
  rpc.expose(method, (request) => handler(...request.args));
import { usePanelTheme } from "@workspace/react";
import {
  flameTreeFromProfile,
  listProfiles,
  listRuns,
  readProfile,
  runSuites,
  saveRun,
  summarize,
  type FlameNode,
  type ProfileRef,
  type RunSummary,
  type SavedRunRef,
  type SuiteRunResult,
  type TestCaseResult,
  type V8Profile,
} from "@workspace/testkit";
import { allSuites } from "@workspace/testkit/suites";
import { Flamegraph } from "./Flamegraph.js";

type RunPhase = "idle" | "running" | "done";

const STATUS_COLOR: Record<TestCaseResult["status"], "green" | "red" | "orange" | "gray"> = {
  passed: "green",
  failed: "red",
  timeout: "red",
  errored: "orange",
  skipped: "gray",
};

let lastRunResult: SuiteRunResult | null = null;

function TestRow({ result }: { result: TestCaseResult }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(result.error) || result.logs.length > 0 || result.supervision;
  return (
    <Card size="1" style={{ cursor: hasDetail ? "pointer" : "default" }} onClick={() => setOpen(!open)}>
      <Flex justify="between" align="center" gap="2">
        <Text size="2" truncate>
          {result.suite} › {result.name}
        </Text>
        <Flex gap="2" align="center" flexShrink="0">
          <Text size="1" color="gray">
            {result.durationMs}ms
          </Text>
          <Badge color={STATUS_COLOR[result.status]}>{result.status}</Badge>
        </Flex>
      </Flex>
      {open && hasDetail && (
        <Box mt="2">
          {result.error && (
            <Callout.Root color="red" size="1">
              <Callout.Text style={{ whiteSpace: "pre-wrap", fontFamily: "monospace" }}>
                {result.error.message}
              </Callout.Text>
            </Callout.Root>
          )}
          {result.logs.length > 0 && (
            <Code size="1" style={{ display: "block", whiteSpace: "pre-wrap", marginTop: 6 }}>
              {result.logs.join("\n")}
            </Code>
          )}
          {result.supervision && result.supervision.findings.length > 0 && (
            <Box mt="2">
              <Text size="1" weight="bold">
                Supervision findings
              </Text>
              {result.supervision.findings.slice(0, 10).map((finding, index) => (
                <Text key={index} size="1" as="div" color={finding.kind === "console-warn" ? "orange" : "red"}>
                  [{finding.kind}] {finding.target}: {finding.message.slice(0, 200)}
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )}
    </Card>
  );
}

function SuitesTab() {
  const suites = useMemo(() => allSuites(), []);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(suites.map((s) => s.name)));
  const [phase, setPhase] = useState<RunPhase>("idle");
  const [results, setResults] = useState<TestCaseResult[]>([]);
  const [summary, setSummary] = useState<RunSummary | null>(null);

  const run = useCallback(async () => {
    setPhase("running");
    setResults([]);
    setSummary(null);
    const chosen = suites.filter((s) => selected.has(s.name));
    try {
      const result = await runSuites(chosen, {
        onTestEnd: (r) => setResults((prev) => [...prev, r]),
      });
      lastRunResult = result;
      setSummary(summarize(result));
      await saveRun(result, { label: "testbench" }).catch(() => undefined);
    } finally {
      setPhase("done");
    }
  }, [suites, selected]);

  return (
    <Flex direction="column" gap="3">
      <Card>
        <Flex direction="column" gap="2">
          {suites.map((s) => (
            <Flex key={s.name} align="center" gap="2">
              <Switch
                size="1"
                checked={selected.has(s.name)}
                onCheckedChange={(checked) =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (checked) next.add(s.name);
                    else next.delete(s.name);
                    return next;
                  })
                }
              />
              <Text size="2">{s.name}</Text>
              <Text size="1" color="gray">
                {s.tests.length} tests
              </Text>
            </Flex>
          ))}
          <Button onClick={() => void run()} disabled={phase === "running" || selected.size === 0}>
            <PlayIcon /> {phase === "running" ? "Running…" : "Run selected"}
          </Button>
        </Flex>
      </Card>
      {summary && (
        <Callout.Root color={summary.failed + summary.errored > 0 ? "red" : "green"} size="1">
          <Callout.Text>
            {summary.passed}/{summary.total} passed · {summary.failed} failed · {summary.errored}{" "}
            errored · {summary.skipped} skipped · {(summary.duration / 1000).toFixed(1)}s
          </Callout.Text>
        </Callout.Root>
      )}
      <Flex direction="column" gap="1">
        {results.map((r, index) => (
          <TestRow key={`${r.suite}-${r.name}-${index}`} result={r} />
        ))}
      </Flex>
    </Flex>
  );
}

function HistoryTab() {
  const [runs, setRuns] = useState<SavedRunRef[]>([]);
  const refresh = useCallback(() => {
    void listRuns().then(setRuns);
  }, []);
  useEffect(refresh, [refresh]);
  return (
    <Flex direction="column" gap="2">
      <Button variant="soft" onClick={refresh}>
        <ReloadIcon /> Refresh
      </Button>
      {runs.length === 0 && (
        <Text size="2" color="gray">
          No saved runs yet.
        </Text>
      )}
      {runs.map((run) => (
        <Card key={run.path} size="1">
          <Flex justify="between" align="center">
            <Text size="2">
              {new Date(run.savedAt).toLocaleString()} {run.label ? `· ${run.label}` : ""}
            </Text>
            <Badge color={run.summary.failed + run.summary.errored > 0 ? "red" : "green"}>
              {run.summary.passed}/{run.summary.total}
            </Badge>
          </Flex>
          {run.summary.failures.length > 0 && (
            <Box mt="1">
              {run.summary.failures.map((failure, index) => (
                <Text key={index} size="1" as="div" color="red" truncate>
                  {failure.suite} › {failure.name}: {failure.error ?? failure.status}
                </Text>
              ))}
            </Box>
          )}
        </Card>
      ))}
    </Flex>
  );
}

function ProfilesTab() {
  const [profiles, setProfiles] = useState<ProfileRef[]>([]);
  const [flame, setFlame] = useState<{ ref: ProfileRef; root: FlameNode } | null>(null);
  const refresh = useCallback(() => {
    void listProfiles().then(setProfiles);
  }, []);
  useEffect(refresh, [refresh]);

  const openProfile = useCallback(async (ref: ProfileRef) => {
    if (ref.kind !== "cpuprofile") return;
    const raw = await readProfile(ref.path);
    setFlame({ ref, root: flameTreeFromProfile(JSON.parse(raw) as V8Profile) });
  }, []);

  return (
    <Flex direction="column" gap="2">
      <Button variant="soft" onClick={refresh}>
        <ReloadIcon /> Refresh
      </Button>
      {profiles.length === 0 && (
        <Text size="2" color="gray">
          No profiles yet. Capture one with profilePanel()/profileWorkerd() from eval.
        </Text>
      )}
      {profiles.map((ref) => (
        <Card
          key={ref.path}
          size="1"
          style={{ cursor: ref.kind === "cpuprofile" ? "pointer" : "default" }}
          onClick={() => void openProfile(ref)}
        >
          <Flex justify="between" align="center">
            <Text size="2" truncate>
              {ref.target}
            </Text>
            <Flex gap="2" align="center" flexShrink="0">
              <Text size="1" color="gray">
                {new Date(ref.startedAt).toLocaleTimeString()} · {ref.durationMs}ms
                {ref.summary.sizeBytes ? ` · ${Math.round(ref.summary.sizeBytes / 1024)}KB` : ""}
              </Text>
              <Badge>{ref.kind}</Badge>
            </Flex>
          </Flex>
          {ref.summary.topFunctions && ref.summary.topFunctions.length > 0 && (
            <Text size="1" color="gray" as="div">
              top: {ref.summary.topFunctions.map((fn) => `${fn.name} ${fn.selfMs}ms`).join(", ")}
            </Text>
          )}
        </Card>
      ))}
      {flame && (
        <Card>
          <Heading size="2" mb="2">
            {flame.ref.target} — {flame.ref.durationMs}ms
          </Heading>
          <Text size="1" color="gray" as="div" mb="2">
            Artifact at <Code>{flame.ref.path}</Code> (speedscope/DevTools-compatible)
          </Text>
          <Flamegraph root={flame.root} />
        </Card>
      )}
    </Flex>
  );
}

function App() {
  const theme = usePanelTheme();
  return (
    <Theme appearance={theme} accentColor="teal" radius="small">
      <Box p="3" style={{ height: "100vh", boxSizing: "border-box" }}>
        <Flex direction="column" gap="3" style={{ height: "100%" }}>
          <Heading size="4">Testbench</Heading>
          <Tabs.Root defaultValue="suites" style={{ flex: 1, minHeight: 0 }}>
            <Tabs.List>
              <Tabs.Trigger value="suites">Suites</Tabs.Trigger>
              <Tabs.Trigger value="history">History</Tabs.Trigger>
              <Tabs.Trigger value="profiles">Profiles</Tabs.Trigger>
            </Tabs.List>
            <ScrollArea style={{ height: "calc(100% - 40px)" }}>
              <Box pt="3" pr="3">
                <Tabs.Content value="suites">
                  <SuitesTab />
                </Tabs.Content>
                <Tabs.Content value="history">
                  <HistoryTab />
                </Tabs.Content>
                <Tabs.Content value="profiles">
                  <ProfilesTab />
                </Tabs.Content>
              </Box>
            </ScrollArea>
          </Tabs.Root>
        </Flex>
      </Box>
    </Theme>
  );
}

// Agent-facing RPC surface: drive the testbench via panel handles.
expose("runSuites", async (filter?: { suite?: string; test?: string }) => {
  const result = await runSuites(allSuites(), { filter });
  lastRunResult = result;
  await saveRun(result, { label: "rpc" }).catch(() => undefined);
  return summarize(result);
});
expose("lastRun", () => (lastRunResult ? summarize(lastRunResult) : null));

const rootElement = document.getElementById("root");
if (rootElement) {
  createRoot(rootElement).render(<App />);
}
