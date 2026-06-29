import { useState } from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Flex,
  Heading,
  Spinner,
  Table,
  Text,
  TextField,
} from "@radix-ui/themes";
import { MagnifyingGlassIcon } from "@radix-ui/react-icons";
import type { AutocompleteDebugResult, DetectedBrowser } from "@workspace/panel-browser";
import { useAsync, browserData, classifyError } from "../useBrowserData";

export function DebugTab(props: { selection: { browser: DetectedBrowser } | null }) {
  return (
    <Flex direction="column" gap="4" p="4" style={{ overflowY: "auto", height: "100%" }}>
      <AutocompleteDebugger />
      <DiagnosticsDrawer selection={props.selection} />
    </Flex>
  );
}

function AutocompleteDebugger() {
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<AutocompleteDebugResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (q: string) => {
    setQuery(q);
    if (!q.trim()) {
      setResult(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setResult(await browserData.getAutocompleteDebug(q));
    } catch (err) {
      const { status, message } = classifyError(err);
      setError(status === "denied" ? "Autocomplete debug not approved." : message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <Heading size="2" mb="1">
        Address-bar autocomplete debugger
      </Heading>
      <Text size="1" color="gray" mb="2" as="div">
        Shows the ranked suggestions for a query, with the reasons each one scores where it does
        (imported history + NatStack-local visits, bookmarks, search engines).
      </Text>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(input);
        }}
      >
        <Flex gap="2">
          <TextField.Root
            placeholder="type a query, e.g. github"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            style={{ flex: 1 }}
          >
            <TextField.Slot>
              <MagnifyingGlassIcon />
            </TextField.Slot>
          </TextField.Root>
          <Button type="submit" disabled={busy}>
            {busy ? <Spinner size="1" /> : "Rank"}
          </Button>
        </Flex>
      </form>

      {error && (
        <Callout.Root color="amber" mt="2" size="1">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      )}

      {result && query && (
        <Box mt="3">
          {result.suggestions.length === 0 ? (
            <Text size="1" color="gray">
              No suggestions for “{query}”.
            </Text>
          ) : (
            <Table.Root size="1" variant="surface">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>#</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Suggestion</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Source</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Why</Table.ColumnHeaderCell>
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {result.suggestions.map((s, i) => (
                  <Table.Row key={i}>
                    <Table.RowHeaderCell>{i + 1}</Table.RowHeaderCell>
                    <Table.Cell>
                      <Text size="1" truncate style={{ maxWidth: 280 }}>
                        {s.title || s.url || s.keyword}
                      </Text>
                    </Table.Cell>
                    <Table.Cell>
                      <Badge
                        size="1"
                        color={
                          s.source === "bookmark"
                            ? "blue"
                            : s.source === "search-engine"
                              ? "purple"
                              : "gray"
                        }
                      >
                        {s.source}
                      </Badge>
                    </Table.Cell>
                    <Table.Cell>
                      <Text size="1" color="gray">
                        {s.reasons.join(", ")}
                      </Text>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          )}
        </Box>
      )}
    </Card>
  );
}

function DiagnosticsDrawer(props: { selection: { browser: DetectedBrowser } | null }) {
  const browser = props.selection?.browser;
  const issues: Array<{ level: "warn" | "info"; title: string; action: string }> = [];
  if (browser?.tccBlocked) {
    issues.push({
      level: "warn",
      title: `${browser.displayName} is blocked by macOS privacy (TCC)`,
      action: "Grant Full Disk Access to this app in System Settings → Privacy & Security, then re-detect.",
    });
  }
  if (browser && browser.family === "safari") {
    issues.push({
      level: "info",
      title: "Safari open tabs are unavailable",
      action: "Safari does not expose a readable session file; import history/bookmarks instead.",
    });
  }
  if (browser && browser.profiles.length === 0) {
    issues.push({
      level: "warn",
      title: `${browser.displayName} has no readable profiles`,
      action: "Make sure the browser has been launched at least once for this user.",
    });
  }

  return (
    <Card>
      <Heading size="2" mb="2">
        Diagnostics
      </Heading>
      {issues.length === 0 ? (
        <Text size="1" color="gray">
          {browser
            ? `No issues detected for ${browser.displayName}.`
            : "Select a profile to see import diagnostics."}
        </Text>
      ) : (
        <Flex direction="column" gap="2">
          {issues.map((issue, i) => (
            <Callout.Root key={i} color={issue.level === "warn" ? "amber" : "gray"} size="1">
              <Callout.Text>
                <Text weight="bold">{issue.title}.</Text> {issue.action}
              </Callout.Text>
            </Callout.Root>
          ))}
        </Flex>
      )}
    </Card>
  );
}
