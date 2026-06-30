# Cookie Management

Browse, search, delete, and export imported cookies.

> **Note:** Imported cookies are automatically synced to the shared Electron browser session after `startImport`. Browser panels get them immediately.

## Re-Import Behavior

Cookie imports are incremental for a browser/profile. Cookies upsert by
`name + domain + path`; identical cookies are left alone, and changed cookies
update in place. Re-running an import pulls in new/changed browser cookies
without duplicating existing stored cookies.

## Interactive Cookie Manager (Inline UI)

Persistent widget — stays in chat for ongoing cookie management.

```
inline_ui({
  code: `
import { useState, useEffect, useCallback } from "react";
import { Button, Flex, Text, Table, Badge, TextField, Box, Separator, Spinner } from "@radix-ui/themes";
import { TrashIcon, MagnifyingGlassIcon } from "@radix-ui/react-icons";
import { browserData } from "@workspace/panel-browser";

export default function CookieManager({ props, chat }) {
  const [cookies, setCookies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState(props.domain || "");

  const load = useCallback(async () => {
    setLoading(true);
    const result = await browserData.getCookies(filter || undefined);
    setCookies(result);
    setLoading(false);
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const handleDelete = async (id) => {
    await browserData.deleteCookie(id);
    setCookies(prev => prev.filter(c => c.id !== id));
  };

  const handleClear = async () => {
    const count = await browserData.clearCookies(filter || undefined);
    chat.publish("message", { content: "Cleared " + count + " cookies" + (filter ? " for " + filter : "") });
    load();
  };

  // Group by domain for summary
  const domainCounts = {};
  cookies.forEach(c => { domainCounts[c.domain] = (domainCounts[c.domain] || 0) + 1; });
  const topDomains = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);

  return (
    <Flex direction="column" gap="2">
      <Flex gap="2" align="center">
        <Box style={{ position: "relative", flex: 1 }}>
          <MagnifyingGlassIcon style={{ position: "absolute", left: 8, top: 8, color: "var(--gray-9)" }} />
          <TextField.Root placeholder="Filter by domain..." value={filter}
            onChange={e => setFilter(e.target.value)}
            style={{ paddingLeft: 28 }} />
        </Box>
        <Button size="1" variant="soft" color="red" onClick={handleClear}>Clear</Button>
      </Flex>

      <Flex gap="1" wrap="wrap">
        {topDomains.map(([domain, count]) => (
          <Badge key={domain} size="1" variant="soft" style={{ cursor: "pointer" }}
            onClick={() => setFilter(domain)}>
            {domain} ({count})
          </Badge>
        ))}
      </Flex>

      {loading ? <Spinner size="1" /> : (
        <>
          <Text size="1" color="gray">{cookies.length} cookies{filter ? " matching " + filter : ""}</Text>
          <Box style={{ maxHeight: 300, overflow: "auto" }}>
            <Table.Root size="1">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Domain</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Name</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Expires</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Flags</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {cookies.slice(0, 100).map(c => (
                  <Table.Row key={c.id}>
                    <Table.Cell><Text size="1">{c.domain}</Text></Table.Cell>
                    <Table.Cell><Text size="1" style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis" }}>{c.name}</Text></Table.Cell>
                    <Table.Cell><Text size="1" color="gray">{c.expiration_date ? new Date(c.expiration_date * 1000).toLocaleDateString() : "session"}</Text></Table.Cell>
                    <Table.Cell>
                      <Flex gap="1">
                        {c.secure && <Badge size="1" variant="outline">🔒</Badge>}
                        {c.http_only && <Badge size="1" variant="outline">H</Badge>}
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Button size="1" variant="ghost" color="red" onClick={() => handleDelete(c.id)}>
                        <TrashIcon />
                      </Button>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
          {cookies.length > 100 && <Text size="1" color="gray">Showing 100 of {cookies.length}</Text>}
        </>
      )}
    </Flex>
  );
}`,
  props: {}
})
```

## Headless Cookie Operations (Eval)

### List cookies by domain

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  const cookies = await browserData.getCookies("github.com");
  console.log(cookies.length + " cookies for github.com");
  for (const c of cookies.slice(0, 10)) {
    console.log("  " + c.name + " = " + (c.value?.slice(0, 20) || "(empty)") + "...");
  }
  return { count: cookies.length, sample: cookies.slice(0, 5) };
` })
```

### Export cookies

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  // Formats: "json" or "netscape-txt" (curl/wget compatible)
  const exported = await browserData.exportCookies("netscape-txt");
  console.log(exported.slice(0, 500));
  return exported;
` })
```
