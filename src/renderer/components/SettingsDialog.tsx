import { useEffect, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Dialog,
  Flex,
  Heading,
  Select,
  Separator,
  Spinner,
  Text,
  TextField,
} from "@radix-ui/themes";
import { EyeClosedIcon, EyeOpenIcon, InfoCircledIcon, TrashIcon } from "@radix-ui/react-icons";

import {
  settingsDialogOpenAtom,
  settingsDataAtom,
  settingsLoadingAtom,
  loadSettingsAtom,
  setApiKeyAtom,
  removeApiKeyAtom,
  setModelRoleAtom,
  enableProviderAtom,
  disableProviderAtom,
} from "../state/appModeAtoms";
import type { ProviderInfo } from "../../shared/ipc/types";

const MODEL_ROLES = ["smart", "coding", "fast", "cheap"] as const;

interface SettingsDialogProps {
  /** If true, dialog cannot be dismissed (used for initial setup) */
  isSetupMode?: boolean;
}

export function SettingsDialog({ isSetupMode = false }: SettingsDialogProps) {
  const isOpen = useAtomValue(settingsDialogOpenAtom);
  const settingsData = useAtomValue(settingsDataAtom);
  const isLoading = useAtomValue(settingsLoadingAtom);

  const setIsOpen = useSetAtom(settingsDialogOpenAtom);
  const loadSettings = useSetAtom(loadSettingsAtom);

  // In setup mode, always open; in normal mode, use atom state
  const effectiveIsOpen = isSetupMode || isOpen;

  // Load settings when dialog opens
  useEffect(() => {
    if (effectiveIsOpen) {
      void loadSettings();
    }
  }, [effectiveIsOpen, loadSettings]);

  // In setup mode, only allow closing if providers are configured
  const handleOpenChange = (open: boolean) => {
    if (isSetupMode && !open) {
      // Can only close setup mode if providers are configured
      if (settingsData?.hasConfiguredProviders) {
        setIsOpen(false);
      }
      return;
    }
    setIsOpen(open);
  };

  const canClose = !isSetupMode || (settingsData?.hasConfiguredProviders ?? false);

  return (
    <Dialog.Root open={effectiveIsOpen} onOpenChange={handleOpenChange}>
      <Dialog.Content maxWidth="550px" style={{ maxHeight: "80vh" }}>
        {isSetupMode ? (
          <>
            <Dialog.Title>
              <Heading size="5">Welcome to NatStack</Heading>
            </Dialog.Title>
            <Dialog.Description size="2" color="gray" mb="4">
              Configure at least one AI provider to get started.
            </Dialog.Description>
          </>
        ) : (
          <>
            <Dialog.Title>Settings</Dialog.Title>
            <Dialog.Description size="2" color="gray" mb="4">
              Configure AI providers and model roles.
            </Dialog.Description>
          </>
        )}

        {isLoading ? (
          <Flex align="center" justify="center" py="6">
            <Spinner />
            <Text size="2" ml="2">
              Loading settings...
            </Text>
          </Flex>
        ) : settingsData ? (
          <Flex direction="column" gap="5">
            {/* Setup mode notice */}
            {isSetupMode && !settingsData.hasConfiguredProviders && (
              <Callout.Root color="blue">
                <Callout.Icon>
                  <InfoCircledIcon />
                </Callout.Icon>
                <Callout.Text>
                  Add an API key for at least one provider to continue.
                </Callout.Text>
              </Callout.Root>
            )}

            {/* AI Providers Section */}
            <Box>
              <Text size="2" weight="bold" mb="3" style={{ display: "block" }}>
                AI Providers
              </Text>
              <Flex direction="column" gap="2">
                {settingsData.availableProviders.map((provider) => {
                  const providerInfo = settingsData.providers.find(
                    (p) => p.id === provider.id
                  );
                  return (
                    <ProviderRow
                      key={provider.id}
                      provider={provider}
                      providerInfo={providerInfo}
                    />
                  );
                })}
              </Flex>
            </Box>

            {/* Only show model roles section if providers are configured */}
            {settingsData.hasConfiguredProviders && (
              <>
                <Separator size="4" />

                {/* Model Roles Section */}
                <Box>
                  <Text size="2" weight="bold" mb="3" style={{ display: "block" }}>
                    Model Roles
                  </Text>
                  <Text size="1" color="gray" mb="3" style={{ display: "block" }}>
                    Assign models to roles. Roles fall back to each other: smart ↔
                    coding, fast ↔ cheap.
                  </Text>
                  <Flex direction="column" gap="3">
                    {MODEL_ROLES.map((role) => (
                      <ModelRoleRow
                        key={role}
                        role={role}
                        currentValue={settingsData.modelRoles[role]}
                        providers={settingsData.providers}
                      />
                    ))}
                  </Flex>
                </Box>
              </>
            )}
          </Flex>
        ) : (
          <Text size="2" color="gray">
            Failed to load settings.
          </Text>
        )}

        <Flex gap="3" mt="5" justify="end">
          {isSetupMode ? (
            <Button
              disabled={!canClose}
              onClick={() => handleOpenChange(false)}
            >
              {canClose ? "Continue" : "Configure a provider to continue"}
            </Button>
          ) : (
            <Dialog.Close>
              <Button variant="soft" color="gray">
                Close
              </Button>
            </Dialog.Close>
          )}
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

interface ProviderRowProps {
  provider: { id: string; name: string; envVar: string; usesCliAuth?: boolean };
  providerInfo?: ProviderInfo;
}

function ProviderRow({ provider, providerInfo }: ProviderRowProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const setApiKeyAction = useSetAtom(setApiKeyAtom);
  const removeApiKeyAction = useSetAtom(removeApiKeyAtom);
  const enableProviderAction = useSetAtom(enableProviderAtom);
  const disableProviderAction = useSetAtom(disableProviderAtom);

  const hasKey = providerInfo?.hasApiKey ?? false;
  const usesCliAuth = provider.usesCliAuth ?? false;
  const isEnabled = providerInfo?.isEnabled ?? false;

  const handleSave = async () => {
    if (!apiKey.trim()) return;
    setIsSaving(true);
    try {
      await setApiKeyAction({ providerId: provider.id, apiKey: apiKey.trim() });
      setApiKey("");
      setIsEditing(false);
    } catch (error) {
      console.error("Failed to save API key:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemove = async () => {
    setIsSaving(true);
    try {
      await removeApiKeyAction(provider.id);
    } catch (error) {
      console.error("Failed to remove API key:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleEnable = async () => {
    setIsSaving(true);
    try {
      await enableProviderAction(provider.id);
    } catch (error) {
      console.error("Failed to enable provider:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleDisable = async () => {
    setIsSaving(true);
    try {
      await disableProviderAction(provider.id);
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
      <Card>
        <Flex justify="between" align="center" p="2">
          <Flex align="center" gap="3">
            <Text size="2" weight="medium" style={{ minWidth: "100px" }}>
              {provider.name}
            </Text>
            {isEnabled ? (
              <Badge color="green" size="1">
                Enabled
              </Badge>
            ) : (
              <Badge color="gray" size="1">
                Disabled
              </Badge>
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
              <Button
                variant="soft"
                size="1"
                onClick={handleEnable}
                disabled={isSaving}
              >
                {isSaving ? <Spinner /> : "Enable"}
              </Button>
            )}
          </Flex>
        </Flex>
        {!isEnabled && (
          <Box px="2" pb="2">
            <Text size="1" color="gray">
              Requires Claude Code CLI. Run: npm install -g @anthropic-ai/claude-code && claude login
            </Text>
          </Box>
        )}
      </Card>
    );
  }

  return (
    <Card>
      <Flex justify="between" align="center" p="2">
        <Flex align="center" gap="3">
          <Text size="2" weight="medium" style={{ minWidth: "100px" }}>
            {provider.name}
          </Text>
          {hasKey ? (
            <Badge color="green" size="1">
              Configured
            </Badge>
          ) : (
            <Badge color="gray" size="1">
              Not configured
            </Badge>
          )}
        </Flex>

        {isEditing ? (
          <Flex gap="2" align="center">
            <TextField.Root
              type={showKey ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Enter ${provider.envVar}`}
              size="1"
              style={{ width: "200px" }}
              autoFocus
            />
            <Button
              variant="ghost"
              size="1"
              onClick={() => setShowKey(!showKey)}
            >
              {showKey ? <EyeClosedIcon /> : <EyeOpenIcon />}
            </Button>
            <Button
              size="1"
              onClick={handleSave}
              disabled={!apiKey.trim() || isSaving}
            >
              {isSaving ? <Spinner /> : "Save"}
            </Button>
            <Button
              variant="soft"
              color="gray"
              size="1"
              onClick={handleCancel}
              disabled={isSaving}
            >
              Cancel
            </Button>
          </Flex>
        ) : (
          <Flex gap="2">
            {hasKey ? (
              <>
                <Button
                  variant="soft"
                  size="1"
                  onClick={() => setIsEditing(true)}
                >
                  Change
                </Button>
                <Button
                  variant="soft"
                  color="red"
                  size="1"
                  onClick={handleRemove}
                  disabled={isSaving}
                >
                  {isSaving ? <Spinner /> : <TrashIcon />}
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
}

function ModelRoleRow({ role, currentValue, providers }: ModelRoleRowProps) {
  const [isSaving, setIsSaving] = useState(false);
  const setModelRole = useSetAtom(setModelRoleAtom);

  // Check if a provider is available (has API key or is enabled CLI-auth provider)
  const isProviderAvailable = (provider: ProviderInfo) =>
    provider.hasApiKey || (provider.usesCliAuth && provider.isEnabled);

  // Build list of available models from configured providers
  const availableModels: { value: string; label: string; provider: string }[] =
    [];
  for (const provider of providers) {
    if (isProviderAvailable(provider)) {
      for (const modelId of provider.models) {
        availableModels.push({
          value: `${provider.id}:${modelId}`,
          label: modelId,
          provider: provider.name,
        });
      }
    }
  }

  const handleChange = async (value: string) => {
    if (value === currentValue) return;
    setIsSaving(true);
    try {
      await setModelRole({ role, modelSpec: value });
    } catch (error) {
      console.error("Failed to set model role:", error);
    } finally {
      setIsSaving(false);
    }
  };

  const roleLabels: Record<string, string> = {
    smart: "Smart",
    coding: "Coding",
    fast: "Fast",
    cheap: "Cheap",
  };

  return (
    <Flex align="center" gap="3">
      <Text size="2" style={{ minWidth: "70px" }}>
        {roleLabels[role] || role}:
      </Text>
      <Box style={{ flex: 1 }}>
        <Select.Root
          value={currentValue || ""}
          onValueChange={handleChange}
          disabled={isSaving || availableModels.length === 0}
        >
          <Select.Trigger
            placeholder={
              availableModels.length === 0
                ? "No providers configured"
                : "Select model..."
            }
            style={{ width: "100%" }}
          />
          <Select.Content>
            {/* Group by provider */}
            {providers
              .filter(isProviderAvailable)
              .map((provider) => (
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
