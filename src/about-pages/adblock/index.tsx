/**
 * Ad Block Settings Page - Shell panel for ad blocking configuration.
 *
 * This is a shell panel with full access to shell services.
 * It provides UI for configuring ad blocking, filter lists, and whitelists.
 */

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import {
  Theme,
  Card,
  Flex,
  Heading,
  Text,
  Button,
  TextField,
  Switch,
  Box,
  Badge,
  Spinner,
  IconButton,
} from "@radix-ui/themes";
import { Cross2Icon, PlusIcon } from "@radix-ui/react-icons";
import { rpc } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";

interface AdBlockListConfig {
  ads: boolean;
  privacy: boolean;
  annoyances: boolean;
  social: boolean;
}

interface AdBlockConfig {
  enabled: boolean;
  lists: AdBlockListConfig;
  customLists: string[];
  whitelist: string[];
  lastUpdated?: number;
}

interface AdBlockStats {
  blockedRequests: number;
  blockedElements: number;
}

const LIST_LABELS: Record<keyof AdBlockListConfig, { label: string; description: string }> = {
  ads: {
    label: "EasyList (Ads)",
    description: "Block advertisements from common ad networks",
  },
  privacy: {
    label: "EasyPrivacy (Trackers)",
    description: "Block tracking scripts and analytics",
  },
  annoyances: {
    label: "Fanboy's Annoyances",
    description: "Block cookie notices, social widgets, and other annoyances",
  },
  social: {
    label: "Fanboy's Social",
    description: "Block social media buttons and widgets",
  },
};

/**
 * Format a timestamp as a relative time string.
 */
function formatLastUpdated(timestamp: number | undefined): string {
  if (!timestamp) {
    return "Never";
  }

  const now = Date.now();
  const diff = now - timestamp;
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (minutes < 1) {
    return "Just now";
  } else if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  } else if (hours < 24) {
    return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  } else {
    return `${days} day${days === 1 ? "" : "s"} ago`;
  }
}

function AdBlockSettingsPage() {
  const [config, setConfig] = useState<AdBlockConfig | null>(null);
  const [stats, setStats] = useState<AdBlockStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // New whitelist domain input
  const [newDomain, setNewDomain] = useState("");

  // New custom list URL input
  const [newListUrl, setNewListUrl] = useState("");

  const loadData = async () => {
    try {
      setLoading(true);
      const [configData, statsData] = await Promise.all([
        rpc.call<AdBlockConfig>("main", "adblock.getConfig"),
        rpc.call<AdBlockStats>("main", "adblock.getStats"),
      ]);
      setConfig(configData);
      setStats(statsData);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  const refreshStats = async () => {
    try {
      const statsData = await rpc.call<AdBlockStats>("main", "adblock.getStats");
      setStats(statsData);
    } catch (err) {
      console.error("Failed to refresh stats:", err);
    }
  };

  useEffect(() => {
    loadData();
    // Refresh stats periodically
    const interval = setInterval(refreshStats, 5000);
    return () => clearInterval(interval);
  }, []);

  const handleToggleEnabled = async (enabled: boolean) => {
    if (!config) return;
    setIsSaving(true);
    try {
      await rpc.call<void>("main", "adblock.setEnabled", enabled);
      setConfig({ ...config, enabled });
    } catch (err) {
      console.error("Failed to toggle ad blocking:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleList = async (list: keyof AdBlockListConfig, enabled: boolean) => {
    if (!config) return;
    setIsSaving(true);
    try {
      await rpc.call<void>("main", "adblock.setListEnabled", list, enabled);
      setConfig({
        ...config,
        lists: { ...config.lists, [list]: enabled },
      });
    } catch (err) {
      console.error("Failed to toggle filter list:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddWhitelist = async () => {
    if (!config || !newDomain.trim()) return;
    setIsSaving(true);
    try {
      await rpc.call<void>("main", "adblock.addToWhitelist", newDomain.trim());
      setConfig({
        ...config,
        whitelist: [...config.whitelist, newDomain.trim()],
      });
      setNewDomain("");
    } catch (err) {
      console.error("Failed to add to whitelist:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveWhitelist = async (domain: string) => {
    if (!config) return;
    setIsSaving(true);
    try {
      await rpc.call<void>("main", "adblock.removeFromWhitelist", domain);
      setConfig({
        ...config,
        whitelist: config.whitelist.filter((d) => d !== domain),
      });
    } catch (err) {
      console.error("Failed to remove from whitelist:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddCustomList = async () => {
    if (!config || !newListUrl.trim()) return;
    setIsSaving(true);
    try {
      await rpc.call<void>("main", "adblock.addCustomList", newListUrl.trim());
      setConfig({
        ...config,
        customLists: [...config.customLists, newListUrl.trim()],
      });
      setNewListUrl("");
    } catch (err) {
      console.error("Failed to add custom list:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveCustomList = async (url: string) => {
    if (!config) return;
    setIsSaving(true);
    try {
      await rpc.call<void>("main", "adblock.removeCustomList", url);
      setConfig({
        ...config,
        customLists: config.customLists.filter((u) => u !== url),
      });
    } catch (err) {
      console.error("Failed to remove custom list:", err);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRebuild = async () => {
    setIsSaving(true);
    try {
      await rpc.call<void>("main", "adblock.rebuildEngine");
    } catch (err) {
      console.error("Failed to rebuild engine:", err);
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return (
      <Flex align="center" justify="center" gap="2" style={{ height: "100vh" }}>
        <Spinner />
        <Text>Loading ad block settings...</Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Flex align="center" justify="center" direction="column" gap="3" style={{ height: "100vh" }}>
        <Text color="red">Error: {error}</Text>
        <Button onClick={loadData}>Retry</Button>
      </Flex>
    );
  }

  return (
    <Box p="4" style={{ maxWidth: "600px", margin: "0 auto" }}>
      <Heading size="7" mb="5">Ad Blocking</Heading>

      {/* Master Toggle */}
      <Card mb="4">
        <Flex justify="between" align="center">
          <Flex direction="column">
            <Text weight="medium">Enable Ad Blocking</Text>
            <Text size="1" color="gray">
              Block ads, trackers, and annoyances in browser panels
            </Text>
          </Flex>
          <Switch
            checked={config?.enabled ?? false}
            onCheckedChange={handleToggleEnabled}
            disabled={isSaving}
          />
        </Flex>
      </Card>

      {/* Stats */}
      <Card mb="4">
        <Flex justify="between" align="center">
          <Flex direction="column">
            <Text weight="medium">Session Statistics</Text>
            <Text size="1" color="gray">
              {stats?.blockedRequests.toLocaleString() ?? 0} requests blocked, {stats?.blockedElements.toLocaleString() ?? 0} elements hidden
            </Text>
            <Text size="1" color="gray">
              Filter lists updated: {formatLastUpdated(config?.lastUpdated)}
            </Text>
          </Flex>
          <Badge color={config?.enabled ? "green" : "gray"} size="2">
            {config?.enabled ? "Active" : "Disabled"}
          </Badge>
        </Flex>
      </Card>

      {/* Filter Lists */}
      <Card mb="4">
        <Heading size="4" mb="3">Filter Lists</Heading>
        <Text size="2" color="gray" mb="4">
          Choose which filter lists to use. Changes require rebuilding the engine.
        </Text>

        <Flex direction="column" gap="3">
          {(Object.keys(LIST_LABELS) as Array<keyof AdBlockListConfig>).map((list) => (
            <Flex key={list} justify="between" align="center">
              <Flex direction="column">
                <Text size="2" weight="medium">{LIST_LABELS[list].label}</Text>
                <Text size="1" color="gray">{LIST_LABELS[list].description}</Text>
              </Flex>
              <Switch
                checked={config?.lists[list] ?? false}
                onCheckedChange={(checked) => handleToggleList(list, checked)}
                disabled={isSaving || !config?.enabled}
              />
            </Flex>
          ))}
        </Flex>

        <Box mt="4">
          <Button
            variant="soft"
            onClick={handleRebuild}
            disabled={isSaving || !config?.enabled}
          >
            {isSaving ? <Spinner /> : "Rebuild Filter Engine"}
          </Button>
        </Box>
      </Card>

      {/* Custom Lists */}
      <Card mb="4">
        <Heading size="4" mb="3">Custom Filter Lists</Heading>
        <Text size="2" color="gray" mb="4">
          Add URLs to custom filter lists (e.g., regional ad filters).
        </Text>

        <Flex direction="column" gap="2" mb="3">
          {config?.customLists.map((url) => (
            <Flex key={url} justify="between" align="center" gap="2">
              <Text size="2" style={{ wordBreak: "break-all", flex: 1 }}>{url}</Text>
              <IconButton
                variant="ghost"
                color="red"
                size="1"
                onClick={() => handleRemoveCustomList(url)}
                disabled={isSaving}
              >
                <Cross2Icon />
              </IconButton>
            </Flex>
          ))}
        </Flex>

        <Flex gap="2">
          <TextField.Root
            placeholder="https://example.com/filters.txt"
            value={newListUrl}
            onChange={(e) => setNewListUrl(e.target.value)}
            style={{ flex: 1 }}
            disabled={isSaving || !config?.enabled}
          />
          <IconButton
            onClick={handleAddCustomList}
            disabled={isSaving || !newListUrl.trim() || !config?.enabled}
          >
            <PlusIcon />
          </IconButton>
        </Flex>
      </Card>

      {/* Whitelist */}
      <Card>
        <Heading size="4" mb="3">Whitelisted Domains</Heading>
        <Text size="2" color="gray" mb="4">
          Domains where ad blocking is disabled. Supports wildcards (*.example.com).
        </Text>

        <Flex direction="column" gap="2" mb="3">
          {config?.whitelist.map((domain) => (
            <Flex key={domain} justify="between" align="center" gap="2">
              <Text size="2">{domain}</Text>
              <IconButton
                variant="ghost"
                color="red"
                size="1"
                onClick={() => handleRemoveWhitelist(domain)}
                disabled={isSaving}
              >
                <Cross2Icon />
              </IconButton>
            </Flex>
          ))}
          {config?.whitelist.length === 0 && (
            <Text size="2" color="gray">No whitelisted domains</Text>
          )}
        </Flex>

        <Flex gap="2">
          <TextField.Root
            placeholder="example.com or *.example.com"
            value={newDomain}
            onChange={(e) => setNewDomain(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newDomain.trim()) {
                handleAddWhitelist();
              }
            }}
            style={{ flex: 1 }}
            disabled={isSaving}
          />
          <IconButton
            onClick={handleAddWhitelist}
            disabled={isSaving || !newDomain.trim()}
          >
            <PlusIcon />
          </IconButton>
        </Flex>
      </Card>
    </Box>
  );
}

function ThemedApp() {
  const theme = usePanelTheme();
  return (
    <Theme appearance={theme} radius="medium">
      <AdBlockSettingsPage />
    </Theme>
  );
}

// Mount the app
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<ThemedApp />);
}
