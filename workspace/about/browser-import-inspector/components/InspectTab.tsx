import { useState } from "react";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Flex,
  Grid,
  Heading,
  IconButton,
  Spinner,
  Table,
  Text,
  TextField,
} from "@radix-ui/themes";
import { EyeOpenIcon, EyeClosedIcon, MagnifyingGlassIcon } from "@radix-ui/react-icons";
import type {
  CookieDomainSummary,
  HistoryDomainSummary,
  PasswordOriginSummary,
  DomainReadiness,
} from "@workspace/panel-browser";
import { useAsync, browserData, relativeTime, mask } from "../useBrowserData";

export function InspectTab(props: { now: number }) {
  return (
    <Flex direction="column" gap="4" p="4" style={{ overflowY: "auto", height: "100%" }}>
      <DomainReadinessPanel />
      <Grid columns={{ initial: "1", md: "2" }} gap="4">
        <CookieInspector />
        <PasswordVaultPreview />
      </Grid>
      <HistoryInspector now={props.now} />
    </Flex>
  );
}

function DomainReadinessPanel() {
  const [domain, setDomain] = useState("");
  const [query, setQuery] = useState("");
  const { state } = useAsync<DomainReadiness | null>(
    () => (query ? browserData.getDomainReadiness(query) : Promise.resolve(null)),
    [query],
  );
  const r = state.data;
  const ready = r && r.cookies > 0 && r.password;

  return (
    <Card>
      <Heading size="2" mb="2">
        Domain readiness
      </Heading>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(domain.trim());
        }}
      >
        <Flex gap="2">
          <TextField.Root
            placeholder="github.com"
            value={domain}
            onChange={(e) => setDomain(e.target.value)}
            style={{ flex: 1 }}
          >
            <TextField.Slot>
              <MagnifyingGlassIcon />
            </TextField.Slot>
          </TextField.Root>
          <Button type="submit" variant="soft">
            Check
          </Button>
        </Flex>
      </form>
      {state.status === "loading" && <Spinner size="1" />}
      {r && (
        <Box mt="3">
          <Callout.Root color={ready ? "green" : "gray"} size="1" mb="2">
            <Callout.Text>
              {ready
                ? `${r.domain} is ready: cookies + password${r.recentHistoryCount > 0 ? " + recent history" : ""}.`
                : `${r.domain} is partially set up.`}
            </Callout.Text>
          </Callout.Root>
          <Flex gap="3" wrap="wrap">
            <ReadinessChip label="cookies" ok={r.cookies > 0} detail={`${r.cookies}`} />
            <ReadinessChip label="password" ok={r.password} />
            <ReadinessChip label="permissions" ok={r.permissions.length > 0} detail={`${r.permissions.length}`} />
            <ReadinessChip
              label="recent history"
              ok={r.recentHistoryCount > 0}
              detail={`${r.recentHistoryCount}`}
            />
          </Flex>
        </Box>
      )}
    </Card>
  );
}

function ReadinessChip(props: { label: string; ok: boolean; detail?: string }) {
  return (
    <Badge color={props.ok ? "green" : "gray"} variant="soft">
      {props.label}
      {props.detail ? ` (${props.detail})` : ""}
    </Badge>
  );
}

function CookieInspector() {
  const { state } = useAsync<CookieDomainSummary[]>(() => browserData.getCookieDomains(), []);
  const [revealDomain, setRevealDomain] = useState<string | null>(null);

  return (
    <Card>
      <Heading size="2" mb="2">
        Cookies by domain
      </Heading>
      <Text size="1" color="gray" mb="2" as="div">
        Domains and counts are shown without values. Revealing values requires approval.
      </Text>
      {state.status === "loading" && <Spinner size="1" />}
      {state.status === "ready" && (state.data?.length ?? 0) === 0 && (
        <Text size="1" color="gray">
          No cookies imported yet.
        </Text>
      )}
      <Box style={{ maxHeight: 280, overflowY: "auto" }}>
        <Table.Root size="1">
          <Table.Body>
            {state.data?.map((c) => (
              <Table.Row key={c.domain}>
                <Table.RowHeaderCell>
                  <Text size="1">{c.domain}</Text>
                </Table.RowHeaderCell>
                <Table.Cell>
                  <Badge size="1" variant="soft">
                    {c.count}
                  </Badge>
                </Table.Cell>
                <Table.Cell>
                  {c.secure ? (
                    <Badge size="1" color="green">
                      secure
                    </Badge>
                  ) : null}
                </Table.Cell>
                <Table.Cell>
                  <Button size="1" variant="ghost" onClick={() => setRevealDomain(c.domain)}>
                    reveal
                  </Button>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Box>
      {revealDomain && <CookieReveal domain={revealDomain} onClose={() => setRevealDomain(null)} />}
    </Card>
  );
}

function CookieReveal(props: { domain: string; onClose: () => void }) {
  const { state } = useAsync<Array<Record<string, unknown>>>(
    () => browserData.getCookies(props.domain) as unknown as Promise<Array<Record<string, unknown>>>,
    [props.domain],
  );
  const [revealed, setRevealed] = useState<Set<number>>(new Set());

  return (
    <Box mt="2" p="2" style={{ background: "var(--gray-a3)", borderRadius: "var(--radius-2)" }}>
      <Flex justify="between" align="center" mb="1">
        <Text size="1" weight="bold">
          {props.domain}
        </Text>
        <Button size="1" variant="ghost" onClick={props.onClose}>
          close
        </Button>
      </Flex>
      {state.status === "loading" && <Spinner size="1" />}
      {state.status === "denied" && (
        <Text size="1" color="amber">
          Reveal not approved.
        </Text>
      )}
      {state.status === "error" && (
        <Text size="1" color="red">
          {state.error}
        </Text>
      )}
      <Flex direction="column" gap="1">
        {state.data?.map((cookie, i) => {
          const isRevealed = revealed.has(i);
          return (
            <Flex key={i} gap="2" align="center">
              <Text size="1" weight="bold">
                {String(cookie["name"])}
              </Text>
              <Text size="1" color="gray" style={{ fontFamily: "monospace" }}>
                {mask(String(cookie["value"] ?? ""), isRevealed)}
              </Text>
              <IconButton
                size="1"
                variant="ghost"
                onClick={() =>
                  setRevealed((prev) => {
                    const next = new Set(prev);
                    if (next.has(i)) next.delete(i);
                    else next.add(i);
                    return next;
                  })
                }
              >
                {isRevealed ? <EyeClosedIcon /> : <EyeOpenIcon />}
              </IconButton>
            </Flex>
          );
        })}
      </Flex>
    </Box>
  );
}

function PasswordVaultPreview() {
  const { state } = useAsync<PasswordOriginSummary[]>(() => browserData.getPasswordOrigins(), []);
  const [reveal, setReveal] = useState(false);

  return (
    <Card>
      <Flex justify="between" align="center" mb="2">
        <Heading size="2">Passwords by origin</Heading>
        <Button size="1" variant="soft" onClick={() => setReveal((v) => !v)}>
          {reveal ? <EyeClosedIcon /> : <EyeOpenIcon />} {reveal ? "Hide values" : "Reveal values"}
        </Button>
      </Flex>
      <Text size="1" color="gray" mb="2" as="div">
        Origins and counts only — usernames and passwords stay hidden until revealed.
      </Text>
      {state.status === "loading" && <Spinner size="1" />}
      {state.status === "ready" && (state.data?.length ?? 0) === 0 && (
        <Text size="1" color="gray">
          No passwords imported yet.
        </Text>
      )}
      <Box style={{ maxHeight: 280, overflowY: "auto" }}>
        <Flex direction="column" gap="1">
          {state.data?.map((p) => (
            <Flex key={p.origin} gap="2" align="center" justify="between">
              <Text size="1">{p.origin}</Text>
              <Badge size="1" variant="soft">
                {p.count}
              </Badge>
            </Flex>
          ))}
        </Flex>
      </Box>
      {reveal && <PasswordReveal />}
    </Card>
  );
}

function PasswordReveal() {
  const { state } = useAsync<Array<Record<string, unknown>>>(
    () => browserData.getPasswords() as unknown as Promise<Array<Record<string, unknown>>>,
    [],
  );
  if (state.status === "loading") return <Spinner size="1" />;
  if (state.status === "denied")
    return (
      <Text size="1" color="amber" mt="2" as="div">
        Reveal not approved.
      </Text>
    );
  if (state.status === "error")
    return (
      <Text size="1" color="red" mt="2" as="div">
        {state.error}
      </Text>
    );
  return (
    <Box mt="2" p="2" style={{ background: "var(--gray-a3)", borderRadius: "var(--radius-2)" }}>
      <Flex direction="column" gap="1">
        {state.data?.slice(0, 100).map((p, i) => (
          <Flex key={i} gap="2" align="center">
            <Text size="1">{String(p["origin_url"])}</Text>
            <Text size="1" color="gray">
              {String(p["username"])}
            </Text>
            <Text size="1" style={{ fontFamily: "monospace" }}>
              {String(p["password"])}
            </Text>
          </Flex>
        ))}
      </Flex>
    </Box>
  );
}

function HistoryInspector(props: { now: number }) {
  const { state } = useAsync<HistoryDomainSummary[]>(() => browserData.getHistoryDomains(), []);
  return (
    <Card>
      <Heading size="2" mb="2">
        History by domain
      </Heading>
      {state.status === "loading" && <Spinner size="1" />}
      <Box style={{ maxHeight: 320, overflowY: "auto" }}>
        <Table.Root size="1" variant="surface">
          <Table.Header>
            <Table.Row>
              <Table.ColumnHeaderCell>Domain</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Visits</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Typed</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Pages</Table.ColumnHeaderCell>
              <Table.ColumnHeaderCell>Last</Table.ColumnHeaderCell>
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {state.data?.map((h) => (
              <Table.Row key={h.domain}>
                <Table.RowHeaderCell>
                  <Text size="1">{h.domain}</Text>
                </Table.RowHeaderCell>
                <Table.Cell>{h.visits}</Table.Cell>
                <Table.Cell>{h.typed}</Table.Cell>
                <Table.Cell>{h.pages}</Table.Cell>
                <Table.Cell>
                  <Text size="1" color="gray">
                    {relativeTime(h.lastVisit, props.now)}
                  </Text>
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table.Root>
      </Box>
    </Card>
  );
}
