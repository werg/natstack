# Discovery

Detect installed browsers and enumerate their profiles before importing.

## Headless Discovery (Eval)

```
eval({ code: `
  import { browserData } from "@workspace/panel-browser";
  const browsers = await browserData.detectBrowsers();

  for (const b of browsers) {
    console.log(b.displayName + (b.version ? " v" + b.version : ""));
    console.log("  Data dir:", b.dataDir);
    if (b.tccBlocked) console.log("  ⚠️ TCC blocked (macOS privacy — grant Full Disk Access)");
    for (const p of b.profiles) {
      console.log("  Profile:", p.displayName + (p.isDefault ? " (default)" : ""));
      console.log("    Path:", p.path);
    }
  }
  return browsers;
` })
```

## Rich Discovery UI (Inline UI)

Shows browser cards with profile details and one-click import buttons.

```
inline_ui({
  code: `
import { useState, useEffect } from "react";
import { Button, Flex, Text, Card, Badge, Box, Spinner, Avatar, Separator } from "@radix-ui/themes";
import { browserData } from "@workspace/panel-browser";

const BROWSER_ICONS = {
  chrome: "🌐", firefox: "🦊", safari: "🧭", edge: "🔵",
  brave: "🦁", vivaldi: "🎵", opera: "🔴", chromium: "💠",
};

export default function BrowserDiscovery({ props, chat }) {
  const [browsers, setBrowsers] = useState(null);
  const [importing, setImporting] = useState(null);
  const [results, setResults] = useState([]);

  useEffect(() => { browserData.detectBrowsers().then(setBrowsers); }, []);

  const handleImport = async (browser, profile, dataTypes) => {
    const key = browser.name + ":" + profile.path;
    setImporting(key);
    try {
      const result = await browserData.startImport({
        browser: browser.name,
        profile,
        dataTypes,
      });
      setResults(prev => [...prev, { browser: browser.displayName, profile: profile.displayName, result }]);
    } catch (e) {
      setResults(prev => [...prev, { browser: browser.displayName, profile: profile.displayName, error: e.message }]);
    }
    setImporting(null);
  };

  if (!browsers) return <Flex align="center" gap="2"><Spinner size="1" /><Text size="1">Detecting browsers...</Text></Flex>;
  if (browsers.length === 0) return <Text size="1" color="gray">No browsers detected</Text>;

  return (
    <Flex direction="column" gap="3">
      {browsers.map(browser => (
        <Card key={browser.name} size="1">
          <Flex direction="column" gap="2">
            <Flex align="center" gap="2">
              <Text size="3">{BROWSER_ICONS[browser.name] || "🌐"}</Text>
              <Text size="2" weight="bold">{browser.displayName}</Text>
              {browser.version && <Badge size="1" variant="soft" color="gray">v{browser.version}</Badge>}
              {browser.tccBlocked && <Badge size="1" color="orange">TCC Blocked</Badge>}
            </Flex>

            {browser.profiles.map(profile => {
              const key = browser.name + ":" + profile.path;
              const isImporting = importing === key;
              return (
                <Box key={profile.id} ml="4" style={{ borderLeft: "2px solid var(--gray-a4)", paddingLeft: 12 }}>
                  <Flex align="center" gap="2" justify="between">
                    <Flex align="center" gap="2">
                      {profile.avatarUrl
                        ? <Avatar size="1" src={profile.avatarUrl} fallback={profile.displayName[0]} />
                        : <Text size="1">👤</Text>}
                      <Text size="1" weight="medium">{profile.displayName}</Text>
                      {profile.isDefault && <Badge size="1" variant="soft">Default</Badge>}
                    </Flex>
                    <Flex gap="1">
                      <Button size="1" variant="soft" disabled={isImporting || browser.tccBlocked}
                        onClick={() => handleImport(browser, profile, ["cookies"])}>
                        {isImporting ? <Spinner size="1" /> : "Cookies"}
                      </Button>
                      <Button size="1" variant="soft" disabled={isImporting || browser.tccBlocked}
                        onClick={() => handleImport(browser, profile, ["passwords"])}>
                        Passwords
                      </Button>
                      <Button size="1" variant="soft" disabled={isImporting || browser.tccBlocked}
                        onClick={() => handleImport(browser, profile, ["cookies", "passwords", "bookmarks", "history"])}>
                        All
                      </Button>
                    </Flex>
                  </Flex>
                </Box>
              );
            })}
          </Flex>
        </Card>
      ))}

      {results.length > 0 && (
        <>
          <Separator size="4" />
          <Text size="2" weight="bold">Import Results</Text>
          {results.map((r, i) => (
            <Card key={i} size="1">
              <Text size="1" weight="medium">{r.browser} — {r.profile}</Text>
              {r.error
                ? <Text size="1" color="red">{r.error}</Text>
                : <Flex gap="2" wrap="wrap" mt="1">
                    {r.result.map((item, j) => (
                      <Badge key={j} size="1" color={item.success ? "green" : "red"} variant="soft">
                        {item.dataType}: {item.itemCount} imported{item.skippedCount > 0 ? ", " + item.skippedCount + " skipped" : ""}
                      </Badge>
                    ))}
                  </Flex>}
            </Card>
          ))}
        </>
      )}
    </Flex>
  );
}`,
  props: {}
})
```

## Selective Import Wizard (Feedback Custom)

Blocks the agent until the user picks exactly what to import.

```
feedback_custom({
  code: `
import { useState, useEffect } from "react";
import { Button, Flex, Text, Card, Badge, Box, Spinner, Checkbox, Separator } from "@radix-ui/themes";
import { browserData } from "@workspace/panel-browser";

const DATA_TYPES = ["cookies", "passwords", "bookmarks", "history", "autofill", "searchEngines"];

export default function ImportWizard({ onSubmit, onCancel, chat }) {
  const [browsers, setBrowsers] = useState(null);
  const [selected, setSelected] = useState(null);  // { browser, profile: DetectedProfile }
  const [dataTypes, setDataTypes] = useState(new Set(["cookies", "passwords", "bookmarks"]));

  useEffect(() => { browserData.detectBrowsers().then(setBrowsers); }, []);

  const toggleType = (type) => {
    setDataTypes(prev => {
      const next = new Set(prev);
      next.has(type) ? next.delete(type) : next.add(type);
      return next;
    });
  };

  if (!browsers) return <Flex align="center" gap="2" p="3"><Spinner size="1" /><Text size="1">Detecting...</Text></Flex>;

  // Step 1: Pick browser + profile
  if (!selected) {
    return (
      <Flex direction="column" gap="2" p="2">
        <Text size="2" weight="bold">Select browser profile to import from</Text>
        {browsers.map(b => b.profiles.map(p => (
          <Card key={b.name + p.id} size="1" style={{ cursor: "pointer" }}
            onClick={() => setSelected({ browser: b, profile: p })}>
            <Flex align="center" gap="2">
              <Text size="1" weight="medium">{b.displayName}</Text>
              <Text size="1" color="gray">—</Text>
              <Text size="1">{p.displayName}</Text>
              {p.isDefault && <Badge size="1" variant="soft">Default</Badge>}
              {b.tccBlocked && <Badge size="1" color="orange">Blocked</Badge>}
            </Flex>
          </Card>
        )))}
        <Flex justify="end"><Button variant="soft" onClick={onCancel}>Cancel</Button></Flex>
      </Flex>
    );
  }

  // Step 2: Pick data types + confirm
  return (
    <Flex direction="column" gap="3" p="2">
      <Text size="2" weight="bold">Import from {selected.browser.displayName} — {selected.profile.displayName}</Text>

      <Flex direction="column" gap="1">
        {DATA_TYPES.map(type => (
          <Flex key={type} align="center" gap="2" style={{ cursor: "pointer" }} onClick={() => toggleType(type)}>
            <Checkbox checked={dataTypes.has(type)} />
            <Text size="1">{type}</Text>
          </Flex>
        ))}
      </Flex>

      <Flex gap="2" justify="end">
        <Button variant="soft" onClick={() => setSelected(null)}>Back</Button>
        <Button variant="soft" onClick={onCancel}>Cancel</Button>
        <Button disabled={dataTypes.size === 0}
          onClick={() => onSubmit({
            browser: selected.browser.name,
            profile: selected.profile,
            dataTypes: Array.from(dataTypes),
          })}>
          Import {dataTypes.size} type{dataTypes.size !== 1 ? "s" : ""}
        </Button>
      </Flex>
    </Flex>
  );
}`,
  title: "Browser Import"
})
```

After the user submits, the agent receives `{ browser, profile, dataTypes }` and runs the import via eval.

## Types

```typescript
interface DetectedBrowser {
  name: string;          // "chrome" | "firefox" | "safari" | "edge" | "brave" | ...
  family: string;        // "chromium" | "firefox" | "safari"
  displayName: string;   // "Google Chrome"
  version?: string;
  dataDir: string;       // path to browser data directory
  profiles: DetectedProfile[];
  tccBlocked?: boolean;  // macOS: needs Full Disk Access permission
}

interface DetectedProfile {
  id: string;
  displayName: string;   // "Default" | "Work" | "Person 1"
  path: string;          // full path to profile directory
  isDefault: boolean;
  avatarUrl?: string;    // Chrome profile avatar
}
```
