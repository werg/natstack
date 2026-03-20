# Bookmark Management

Browse, search, and organize imported bookmarks.

## Bookmark Browser (Inline UI)

Folder tree with search and one-click open in browser panel.

```
inline_ui({
  code: `
import { useState, useEffect } from "react";
import { Button, Flex, Text, Box, TextField, Badge, Spinner } from "@radix-ui/themes";
import { BookmarkIcon, MagnifyingGlassIcon, ChevronRightIcon } from "@radix-ui/react-icons";
import { createBrowserDataApi, createBrowserPanel } from "@workspace/panel-browser";

export default function BookmarkBrowser({ props, chat }) {
  const [bookmarks, setBookmarks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [folder, setFolder] = useState("");
  const [search, setSearch] = useState("");
  const [searchResults, setSearchResults] = useState(null);
  const api = createBrowserDataApi(chat.rpc);

  useEffect(() => {
    setLoading(true);
    api.getBookmarks(folder || undefined).then(b => { setBookmarks(b); setLoading(false); });
  }, [folder]);

  const handleSearch = async () => {
    if (!search) { setSearchResults(null); return; }
    const results = await api.searchBookmarks(search);
    setSearchResults(results);
  };

  const handleOpen = (url) => {
    chat.rpc.call("main", "bridge.createBrowserPanel", url, { focus: true });
  };

  // Separate folders from bookmarks
  const folders = bookmarks.filter(b => !b.url);
  const links = searchResults || bookmarks.filter(b => b.url);

  return (
    <Flex direction="column" gap="2">
      <Flex gap="2" align="center">
        <TextField.Root placeholder="Search bookmarks..." value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => e.key === "Enter" && handleSearch()}
          style={{ flex: 1 }} />
        <Button size="1" variant="soft" onClick={handleSearch}><MagnifyingGlassIcon /></Button>
      </Flex>

      {/* Breadcrumb */}
      {folder && (
        <Flex align="center" gap="1">
          <Text size="1" color="blue" style={{ cursor: "pointer" }} onClick={() => setFolder("")}>Root</Text>
          {folder.split("/").filter(Boolean).map((part, i, arr) => (
            <Flex key={i} align="center" gap="1">
              <ChevronRightIcon />
              <Text size="1" color={i === arr.length - 1 ? "gray" : "blue"}
                style={{ cursor: i < arr.length - 1 ? "pointer" : "default" }}
                onClick={() => i < arr.length - 1 && setFolder(arr.slice(0, i + 1).join("/"))}>
                {part}
              </Text>
            </Flex>
          ))}
        </Flex>
      )}

      {loading ? <Spinner size="1" /> : (
        <Box style={{ maxHeight: 300, overflow: "auto" }}>
          <Flex direction="column" gap="1">
            {folders.map(f => (
              <Flex key={f.id} align="center" gap="2" style={{ cursor: "pointer", padding: "2px 4px", borderRadius: 4 }}
                onClick={() => setFolder(f.folder_path + "/" + f.title)}
                onMouseEnter={e => e.currentTarget.style.backgroundColor = "var(--gray-a3)"}
                onMouseLeave={e => e.currentTarget.style.backgroundColor = ""}>
                <Text size="2">📁</Text>
                <Text size="1" weight="medium">{f.title}</Text>
              </Flex>
            ))}
            {links.map(b => (
              <Flex key={b.id} align="center" gap="2" justify="between" style={{ padding: "2px 4px" }}>
                <Flex align="center" gap="2" style={{ flex: 1, minWidth: 0 }}>
                  <BookmarkIcon style={{ flexShrink: 0, color: "var(--blue-9)" }} />
                  <Text size="1" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{b.title || b.url}</Text>
                </Flex>
                <Button size="1" variant="ghost" onClick={() => handleOpen(b.url)}>Open</Button>
              </Flex>
            ))}
            {links.length === 0 && folders.length === 0 && <Text size="1" color="gray">Empty</Text>}
          </Flex>
        </Box>
      )}
    </Flex>
  );
}`,
  props: {}
})
```

## Headless Bookmark Operations (Eval)

### Search bookmarks

```
eval({ code: `
  import { createBrowserDataApi } from "@workspace/panel-browser";
  import { rpc } from "@workspace/runtime";
  const api = createBrowserDataApi(rpc);
  const results = await api.searchBookmarks("github");
  for (const b of results.slice(0, 10)) {
    console.log(b.title + " → " + b.url);
  }
  return results;
` })
```

### Export bookmarks

```
eval({ code: `
  import { createBrowserDataApi } from "@workspace/panel-browser";
  import { rpc } from "@workspace/runtime";
  const api = createBrowserDataApi(rpc);
  // Formats: "html", "json", "chrome-json"
  const exported = await api.exportBookmarks("html");
  console.log("Exported " + exported.length + " bytes of HTML bookmarks");
  return { length: exported.length, preview: exported.slice(0, 300) };
` })
```
