/**
 * Ad Block Settings Page - Shell panel for ad blocking configuration.
 *
 * This is a shell panel with full access to shell services.
 * It provides UI for configuring ad blocking, filter lists, and whitelists.
 */
import { useEffect, useState } from "react";
import {
  Flex,
  Text,
  Button,
  TextField,
  Switch,
  Box,
  Badge,
  Spinner,
  IconButton,
  Separator,
  Card,
} from "@radix-ui/themes";
import { Cross2Icon, PlusIcon, LockClosedIcon } from "@radix-ui/react-icons";
import { rpc } from "@workspace/runtime";
import { useIsMobile } from "@workspace/react";
import { AboutThemeRoot, AboutPage, Section } from "@workspace/about-shared/ui";

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

/** Format a timestamp as a relative time string. */
function formatLastUpdated(timestamp: number | undefined): string {
  if (!timestamp) {
    return "Never";
  }
  const diff = Date.now() - timestamp;
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

function StatBlock({ value, label }: { value: number; label: string }) {
  return (
    <Card variant="surface" style={{ flex: 1 }}>
      <Flex direction="column" align="center" py="1">
        <Text size="6" weight="bold">
          {value.toLocaleString()}
        </Text>
        <Text size="1" color="gray">
          {label}
        </Text>
      </Flex>
    </Card>
  );
}

/** A label/description pair with a switch on the right. */
function ToggleRow({
  label,
  description,
  checked,
  onCheckedChange,
  disabled,
}: {
  label: string;
  description: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  return (
    <Flex justify="between" align="center" gap="3">
      <Flex direction="column" style={{ minWidth: 0 }}>
        <Text size="2" weight="medium">
          {label}
        </Text>
        <Text size="1" color="gray">
          {description}
        </Text>
      </Flex>
      <Switch checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
    </Flex>
  );
}

/** A removable list entry row (custom list URL or whitelisted domain). */
function RemovableRow({
  value,
  onRemove,
  disabled,
}: {
  value: string;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <Flex justify="between" align="center" gap="2">
      <Text size="2" style={{ wordBreak: "break-all", flex: 1 }}>
        {value}
      </Text>
      <IconButton variant="ghost" color="red" size="1" onClick={onRemove} disabled={disabled}>
        <Cross2Icon />
      </IconButton>
    </Flex>
  );
}

function AdBlockSettingsPage() {
  const isMobile = useIsMobile();
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
        rpc.call<AdBlockConfig>("main", "adblock.getConfig", []),
        rpc.call<AdBlockStats>("main", "adblock.getStats", []),
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
      const statsData = await rpc.call<AdBlockStats>("main", "adblock.getStats", []);
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
      await rpc.call<unknown>("main", "adblock.setEnabled", [enabled]);
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
      await rpc.call<unknown>("main", "adblock.setListEnabled", [list, enabled]);
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
      await rpc.call<unknown>("main", "adblock.addToWhitelist", [newDomain.trim()]);
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
      await rpc.call<unknown>("main", "adblock.removeFromWhitelist", [domain]);
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
      await rpc.call<unknown>("main", "adblock.addCustomList", [newListUrl.trim()]);
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
      await rpc.call<unknown>("main", "adblock.removeCustomList", [url]);
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
      await rpc.call<unknown>("main", "adblock.rebuildEngine", []);
    } catch (err) {
      console.error("Failed to rebuild engine:", err);
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return (
      <Flex align="center" justify="center" gap="2" style={{ height: "100dvh" }}>
        <Spinner />
        <Text>Loading ad block settings...</Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Flex align="center" justify="center" direction="column" gap="3" style={{ height: "100dvh" }}>
        <Text color="red">Error: {error}</Text>
        <Button onClick={loadData}>Retry</Button>
      </Flex>
    );
  }

  return (
    <AboutPage
      icon={<LockClosedIcon width={20} height={20} />}
      title="Ad Blocking"
      subtitle={`Filter lists updated: ${formatLastUpdated(config?.lastUpdated)}`}
      maxWidth={640}
      actions={
        <Badge color={config?.enabled ? "green" : "gray"} size="2" variant="soft">
          {config?.enabled ? "Active" : "Disabled"}
        </Badge>
      }
    >
      {/* Master toggle + session stats */}
      <Section>
        <ToggleRow
          label="Enable Ad Blocking"
          description="Block ads, trackers, and annoyances in browser panels"
          checked={config?.enabled ?? false}
          onCheckedChange={handleToggleEnabled}
          disabled={isSaving}
        />
        <Separator size="4" my="3" />
        <Flex gap="3" direction={isMobile ? "column" : "row"}>
          <StatBlock value={stats?.blockedRequests ?? 0} label="Requests blocked this session" />
          <StatBlock value={stats?.blockedElements ?? 0} label="Elements hidden this session" />
        </Flex>
      </Section>

      {/* Filter Lists */}
      <Section
        title="Filter Lists"
        description="Choose which filter lists to use. Changes require rebuilding the engine."
      >
        <Flex direction="column" gap="3">
          {(Object.keys(LIST_LABELS) as Array<keyof AdBlockListConfig>).map((list) => (
            <ToggleRow
              key={list}
              label={LIST_LABELS[list].label}
              description={LIST_LABELS[list].description}
              checked={config?.lists[list] ?? false}
              onCheckedChange={(checked) => handleToggleList(list, checked)}
              disabled={isSaving || !config?.enabled}
            />
          ))}
        </Flex>
        <Box mt="4">
          <Button variant="soft" onClick={handleRebuild} disabled={isSaving || !config?.enabled}>
            {isSaving ? <Spinner /> : "Rebuild Filter Engine"}
          </Button>
        </Box>
      </Section>

      {/* Custom Lists */}
      <Section
        title="Custom Filter Lists"
        description="Add URLs to custom filter lists (e.g., regional ad filters)."
      >
        {config && config.customLists.length > 0 && (
          <Flex direction="column" gap="2" mb="3">
            {config.customLists.map((url) => (
              <RemovableRow
                key={url}
                value={url}
                onRemove={() => handleRemoveCustomList(url)}
                disabled={isSaving}
              />
            ))}
          </Flex>
        )}
        <Flex gap="2" direction={isMobile ? "column" : "row"}>
          <TextField.Root
            placeholder="https://example.com/filters.txt"
            value={newListUrl}
            onChange={(e) => setNewListUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && newListUrl.trim()) {
                handleAddCustomList();
              }
            }}
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
      </Section>

      {/* Whitelist */}
      <Section
        title="Whitelisted Domains"
        description="Domains where ad blocking is disabled. Supports wildcards (*.example.com)."
      >
        <Flex direction="column" gap="2" mb="3">
          {config?.whitelist.map((domain) => (
            <RemovableRow
              key={domain}
              value={domain}
              onRemove={() => handleRemoveWhitelist(domain)}
              disabled={isSaving}
            />
          ))}
          {config?.whitelist.length === 0 && (
            <Text size="2" color="gray">
              No whitelisted domains
            </Text>
          )}
        </Flex>
        <Flex gap="2" direction={isMobile ? "column" : "row"}>
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
          <IconButton onClick={handleAddWhitelist} disabled={isSaving || !newDomain.trim()}>
            <PlusIcon />
          </IconButton>
        </Flex>
      </Section>
    </AboutPage>
  );
}

export default function AboutPanelRoot() {
  return (
    <AboutThemeRoot>
      <AdBlockSettingsPage />
    </AboutThemeRoot>
  );
}
