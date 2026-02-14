/**
 * Model Provider Config Page - Shell panel for AI provider configuration.
 *
 * This is a shell panel with full access to shell services.
 * It provides UI for configuring API keys and model roles.
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
  Select,
  Box,
  Separator,
  Badge,
  Spinner,
} from "@radix-ui/themes";
import { rpc } from "@natstack/runtime";
import { usePanelTheme } from "@natstack/react";
import type { SettingsData, ProviderInfo, AvailableProvider } from "../../shared/types.js";

const MODEL_ROLES = ["smart", "coding", "fast", "cheap"] as const;

const ROLE_LABELS: Record<string, string> = {
  smart: "Smart",
  coding: "Coding",
  fast: "Fast",
  cheap: "Cheap",
};

function ModelProviderConfigPage() {
  const [settingsData, setSettingsData] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load config data (with spinner for initial load)
  const loadConfig = async () => {
    try {
      setLoading(true);
      const data = await rpc.call<SettingsData>("main", "settings.getData");
      setSettingsData(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  };

  // Refresh config data silently (no spinner, for after changes)
  const refreshConfig = async () => {
    try {
      const data = await rpc.call<SettingsData>("main", "settings.getData");
      setSettingsData(data);
      setError(null);
    } catch (err) {
      console.error("Failed to refresh config:", err);
    }
  };

  // Initial load
  useEffect(() => {
    loadConfig();
  }, []);

  if (loading) {
    return (
      <Flex align="center" justify="center" gap="2" style={{ height: "100vh" }}>
        <Spinner />
        <Text>Loading model provider config...</Text>
      </Flex>
    );
  }

  if (error) {
    return (
      <Flex align="center" justify="center" direction="column" gap="3" style={{ height: "100vh" }}>
        <Text color="red">Error: {error}</Text>
        <Button onClick={loadConfig}>Retry</Button>
      </Flex>
    );
  }

  return (
    <Box p="4" style={{ maxWidth: "600px", margin: "0 auto" }}>
      <Heading size="7" mb="5">Model Provider Config</Heading>

      <Card mb="4">
        <Heading size="4" mb="2">Providers</Heading>
        <Text size="2" color="gray" mb="4">
          Configure API keys for AI providers. At least one provider must be configured.
        </Text>

        <Flex direction="column" gap="3">
          {settingsData?.availableProviders.map((provider) => {
            const providerInfo = settingsData.providers.find((p) => p.id === provider.id);
            return (
              <ProviderRow
                key={provider.id}
                provider={provider}
                providerInfo={providerInfo}
                onUpdate={refreshConfig}
              />
            );
          })}
        </Flex>
      </Card>

      {settingsData?.hasConfiguredProviders && (
        <Card>
          <Heading size="4" mb="2">Model Roles</Heading>
          <Text size="2" color="gray" mb="4">
            Assign models to roles. Roles fall back to each other: smart ↔ coding, fast ↔ cheap.
          </Text>

          <Flex direction="column" gap="3">
            {MODEL_ROLES.map((role) => (
              <ModelRoleRow
                key={role}
                role={role}
                currentValue={settingsData.modelRoles[role]}
                providers={settingsData.providers}
                onRoleChange={(newValue) => {
                  // Optimistically update local state without refetching
                  setSettingsData((prev) =>
                    prev ? { ...prev, modelRoles: { ...prev.modelRoles, [role]: newValue } } : prev
                  );
                }}
              />
            ))}
          </Flex>
        </Card>
      )}
    </Box>
  );
}

interface ProviderRowProps {
  provider: AvailableProvider;
  providerInfo?: ProviderInfo;
  onUpdate: () => void;
}

function ProviderRow({ provider, providerInfo, onUpdate }: ProviderRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  const hasKey = providerInfo?.hasApiKey ?? false;
  const usesCliAuth = provider.usesCliAuth ?? false;
  const isEnabled = providerInfo?.isEnabled ?? false;

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setIsSaving(true);
    try {
      await rpc.call<void>("main", "settings.setApiKey", provider.id, apiKey.trim());
      setApiKey("");
      setIsEditing(false);
      onUpdate();
    } catch (error) {
      console.error("Failed to save API key:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async () => {
    setIsSaving(true);
    try {
      await rpc.call<void>("main", "settings.removeApiKey", provider.id);
      onUpdate();
    } catch (error) {
      console.error("Failed to remove API key:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleEnable = async () => {
    setIsSaving(true);
    try {
      await rpc.call<void>("main", "settings.enableProvider", provider.id);
      onUpdate();
    } catch (error) {
      console.error("Failed to enable provider:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisable = async () => {
    setIsSaving(true);
    try {
      await rpc.call<void>("main", "settings.disableProvider", provider.id);
      onUpdate();
    } catch (error) {
      console.error("Failed to disable provider:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setApiKey("");
    setIsEditing(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && apiKey.trim()) {
      void handleSave();
    } else if (e.key === "Escape") {
      handleCancel();
    }
  };

  // For CLI-auth providers (like Claude Code), show enable/disable instead of API key
  if (usesCliAuth) {
    return (
      <Card variant="surface">
        <Flex justify="between" align="center">
          <Flex align="center" gap="3">
            <Text size="2" weight="medium" style={{ minWidth: "100px" }}>
              {provider.name}
            </Text>
            {isEnabled ? (
              <Badge color="green" size="1">Enabled</Badge>
            ) : (
              <Badge color="gray" size="1">Disabled</Badge>
            )}
          </Flex>

          <Flex gap="2" align="center">
            {isEnabled ? (
              <Button
                variant="soft"
                color="red"
                size="1"
                onClick={handleDisable}
                disabled={isSaving}
              >
                {isSaving ? <Spinner /> : "Disable"}
              </Button>
            ) : (
              <Button variant="soft" size="1" onClick={handleEnable} disabled={isSaving}>
                {isSaving ? <Spinner /> : "Enable"}
              </Button>
            )}
          </Flex>
        </Flex>
        {!isEnabled && (
          <Box mt="2">
            <Text size="1" color="gray">
              {provider.id === "claude-code"
                ? "Requires CLI installation. Run: npm install -g @anthropic-ai/claude-code && claude login"
                : provider.id === "codex-cli"
                  ? "Requires CLI installation. Run: npm install -g @openai/codex && codex login"
                  : "Requires CLI authentication. Please install and log in to the CLI tool."}
            </Text>
          </Box>
        )}
      </Card>
    );
  }

  return (
    <Card variant="surface">
      <Flex justify="between" align="center">
        <Flex align="center" gap="3">
          <Text size="2" weight="medium" style={{ minWidth: "100px" }}>
            {provider.name}
          </Text>
          {hasKey ? (
            <Badge color="green" size="1">Configured</Badge>
          ) : (
            <Badge color="gray" size="1">Not configured</Badge>
          )}
        </Flex>

        {isEditing ? (
          <Flex gap="2" align="center">
            <TextField.Root
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Enter ${provider.envVar}`}
              size="1"
              style={{ width: "200px" }}
              autoFocus
            />
            <Button size="1" onClick={handleSave} disabled={!apiKey.trim() || isSaving}>
              {isSaving ? <Spinner /> : "Save"}
            </Button>
            <Button variant="soft" color="gray" size="1" onClick={handleCancel} disabled={isSaving}>
              Cancel
            </Button>
          </Flex>
        ) : (
          <Flex gap="2">
            {hasKey ? (
              <>
                <Button variant="soft" size="1" onClick={() => setIsEditing(true)}>
                  Change
                </Button>
                <Button
                  variant="soft"
                  color="red"
                  size="1"
                  onClick={handleRemove}
                  disabled={isSaving}
                >
                  {isSaving ? <Spinner /> : "Remove"}
                </Button>
              </>
            ) : (
              <Button variant="soft" size="1" onClick={() => setIsEditing(true)}>
                Add Key
              </Button>
            )}
          </Flex>
        )}
      </Flex>
    </Card>
  );
}

interface ModelRoleRowProps {
  role: string;
  currentValue?: string;
  providers: ProviderInfo[];
  onRoleChange: (newValue: string) => void;
}

function ModelRoleRow({ role, currentValue, providers, onRoleChange }: ModelRoleRowProps) {
  const [isSaving, setIsSaving] = useState(false);

  // Check if a provider is available (has API key or is enabled CLI-auth provider)
  const isProviderAvailable = (provider: ProviderInfo) =>
    provider.hasApiKey || (provider.usesCliAuth && provider.isEnabled);

  // Get available providers with models
  const availableProviders = providers.filter(isProviderAvailable);

  const handleChange = async (value: string) => {
    if (value === currentValue) return;
    setIsSaving(true);
    try {
      await rpc.call<void>("main", "settings.setModelRole", role, value);
      // Optimistically update local state (no refetch needed)
      onRoleChange(value);
    } catch (error) {
      console.error("Failed to set model role:", error);
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Flex align="center" gap="3">
      <Text size="2" style={{ minWidth: "70px" }}>
        {ROLE_LABELS[role] || role}:
      </Text>
      <Box style={{ flex: 1 }}>
        <Select.Root
          value={currentValue || ""}
          onValueChange={handleChange}
          disabled={isSaving || availableProviders.length === 0}
        >
          <Select.Trigger
            placeholder={
              availableProviders.length === 0 ? "No providers configured" : "Select model..."
            }
            style={{ width: "100%" }}
          />
          <Select.Content>
            {/* Group by provider */}
            {availableProviders.map((provider) => (
              <Select.Group key={provider.id}>
                <Select.Label>{provider.name}</Select.Label>
                {provider.models.map((modelId) => (
                  <Select.Item
                    key={`${provider.id}:${modelId}`}
                    value={`${provider.id}:${modelId}`}
                  >
                    {modelId}
                  </Select.Item>
                ))}
              </Select.Group>
            ))}
          </Select.Content>
        </Select.Root>
      </Box>
      {isSaving && <Spinner />}
    </Flex>
  );
}

function ThemedApp() {
  const theme = usePanelTheme();
  return (
    <Theme appearance={theme} radius="medium">
      <ModelProviderConfigPage />
    </Theme>
  );
}

// Mount the app
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<ThemedApp />);
}
