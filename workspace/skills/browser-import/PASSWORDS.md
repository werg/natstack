# Password Management

Browse, search, and manage imported passwords.

## Password Vault (Inline UI)

Persistent widget with masked passwords, reveal-on-click, and copy.

```
inline_ui({
  code: `
import { useState, useEffect, useCallback } from "react";
import { Button, Flex, Text, Table, Badge, TextField, Box, Spinner, IconButton } from "@radix-ui/themes";
import { EyeOpenIcon, EyeClosedIcon, CopyIcon, CheckIcon, MagnifyingGlassIcon } from "@radix-ui/react-icons";
import { createBrowserDataApi } from "@workspace/panel-browser";

export default function PasswordVault({ props, chat }) {
  const [passwords, setPasswords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const [revealed, setRevealed] = useState(new Set());
  const [copied, setCopied] = useState(null);
  const api = createBrowserDataApi(chat.rpc);

  const load = useCallback(async () => {
    setLoading(true);
    const result = await api.getPasswords(filter || undefined);
    setPasswords(result);
    setLoading(false);
  }, [filter]);

  useEffect(() => { load(); }, [load]);

  const toggleReveal = (id) => {
    setRevealed(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const copyToClipboard = async (text, id) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
  };

  return (
    <Flex direction="column" gap="2">
      <Box style={{ position: "relative" }}>
        <MagnifyingGlassIcon style={{ position: "absolute", left: 8, top: 8, color: "var(--gray-9)" }} />
        <TextField.Root placeholder="Search by domain..." value={filter}
          onChange={e => setFilter(e.target.value)} style={{ paddingLeft: 28 }} />
      </Box>

      {loading ? <Spinner size="1" /> : (
        <>
          <Text size="1" color="gray">{passwords.length} passwords{filter ? " matching " + filter : ""}</Text>
          <Box style={{ maxHeight: 350, overflow: "auto" }}>
            <Table.Root size="1">
              <Table.Header>
                <Table.Row>
                  <Table.ColumnHeaderCell>Site</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Username</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell>Password</Table.ColumnHeaderCell>
                  <Table.ColumnHeaderCell />
                </Table.Row>
              </Table.Header>
              <Table.Body>
                {passwords.slice(0, 50).map(p => (
                  <Table.Row key={p.id}>
                    <Table.Cell><Text size="1" style={{ maxWidth: 150, overflow: "hidden", textOverflow: "ellipsis" }}>{p.origin_url}</Text></Table.Cell>
                    <Table.Cell>
                      <Flex align="center" gap="1">
                        <Text size="1">{p.username}</Text>
                        <IconButton size="1" variant="ghost" onClick={() => copyToClipboard(p.username, "u" + p.id)}>
                          {copied === "u" + p.id ? <CheckIcon /> : <CopyIcon />}
                        </IconButton>
                      </Flex>
                    </Table.Cell>
                    <Table.Cell>
                      <Flex align="center" gap="1">
                        <Text size="1" style={{ fontFamily: "monospace" }}>
                          {revealed.has(p.id) ? p.password : "••••••••"}
                        </Text>
                        <IconButton size="1" variant="ghost" onClick={() => toggleReveal(p.id)}>
                          {revealed.has(p.id) ? <EyeClosedIcon /> : <EyeOpenIcon />}
                        </IconButton>
                        <IconButton size="1" variant="ghost" onClick={() => copyToClipboard(p.password, "p" + p.id)}>
                          {copied === "p" + p.id ? <CheckIcon /> : <CopyIcon />}
                        </IconButton>
                      </Flex>
                    </Table.Cell>
                  </Table.Row>
                ))}
              </Table.Body>
            </Table.Root>
          </Box>
        </>
      )}
    </Flex>
  );
}`,
  props: {}
})
```

## Headless Password Operations (Eval)

### Find password for a site

```
eval({ code: `
  import { createBrowserDataApi } from "@workspace/panel-browser";
  import { rpc } from "@workspace/runtime";
  const api = createBrowserDataApi(rpc);
  const match = await api.getPasswordForSite("https://github.com/login");
  if (match) {
    console.log("Found:", match.username, "for", match.origin_url);
  } else {
    console.log("No saved password for this site");
  }
  return match;
` })
```

### Export passwords

```
eval({ code: `
  import { createBrowserDataApi } from "@workspace/panel-browser";
  import { rpc } from "@workspace/runtime";
  const api = createBrowserDataApi(rpc);
  // Formats: "csv-chrome", "csv-firefox", "json"
  const exported = await api.exportPasswords("json");
  const parsed = JSON.parse(exported);
  console.log(parsed.length + " passwords exported");
  return { count: parsed.length };
` })
```
