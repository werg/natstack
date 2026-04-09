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
  Spinner,
  Text,
} from "@radix-ui/themes";
import { InfoCircledIcon } from "@radix-ui/react-icons";

import {
  settingsDialogOpenAtom,
  authProvidersAtom,
  authProvidersLoadingAtom,
  loadAuthProvidersAtom,
} from "../state/appModeAtoms";
import { useShellOverlay } from "../shell/useShellOverlay";
import { auth, type AuthProvider } from "../shell/client";

interface SettingsDialogProps {
  /** If true, dialog cannot be dismissed (used for initial setup) */
  isSetupMode?: boolean;
}

function isProviderReady(p: AuthProvider): boolean {
  return p.status === "connected" || p.status === "configured";
}

export function SettingsDialog({ isSetupMode = false }: SettingsDialogProps) {
  const isOpen = useAtomValue(settingsDialogOpenAtom);
  const providers = useAtomValue(authProvidersAtom);
  const isLoading = useAtomValue(authProvidersLoadingAtom);

  const setIsOpen = useSetAtom(settingsDialogOpenAtom);
  const loadProviders = useSetAtom(loadAuthProvidersAtom);

  // In setup mode, always open; in normal mode, use atom state
  const effectiveIsOpen = isSetupMode || isOpen;
  useShellOverlay(effectiveIsOpen);

  // Load providers whenever the dialog opens.
  useEffect(() => {
    if (effectiveIsOpen) {
      void loadProviders();
    }
  }, [effectiveIsOpen, loadProviders]);

  const hasConfiguredProviders = (providers ?? []).some(isProviderReady);

  // In setup mode, only allow closing if providers are configured.
  const handleOpenChange = (open: boolean) => {
    if (isSetupMode && !open) {
      if (hasConfiguredProviders) {
        setIsOpen(false);
      }
      return;
    }
    setIsOpen(open);
  };

  const canClose = !isSetupMode || hasConfiguredProviders;

  const oauthProviders = (providers ?? []).filter((p) => p.kind === "oauth");
  const envProviders = (providers ?? []).filter((p) => p.kind === "env");

  return (
    <Dialog.Root open={effectiveIsOpen} onOpenChange={handleOpenChange}>
      <Dialog.Content maxWidth="550px" style={{ maxHeight: "80dvh" }}>
        {isSetupMode ? (
          <>
            <Dialog.Title>
              <Heading size="5">Welcome to NatStack</Heading>
            </Dialog.Title>
            <Dialog.Description size="2" color="gray" mb="4">
              Connect an AI provider to get started.
            </Dialog.Description>
          </>
        ) : (
          <>
            <Dialog.Title>Settings</Dialog.Title>
            <Dialog.Description size="2" color="gray" mb="4">
              Manage AI provider connections.
            </Dialog.Description>
          </>
        )}

        {isLoading && providers === null ? (
          <Flex align="center" justify="center" py="6">
            <Spinner />
            <Text size="2" ml="2">
              Loading providers...
            </Text>
          </Flex>
        ) : (
          <Flex direction="column" gap="5">
            {/* Setup mode notice */}
            {isSetupMode && !hasConfiguredProviders && (
              <Callout.Root color="blue">
                <Callout.Icon>
                  <InfoCircledIcon />
                </Callout.Icon>
                <Callout.Text>
                  Connect at least one AI provider to continue.
                </Callout.Text>
              </Callout.Root>
            )}

            <Box>
              <Text size="2" weight="bold" mb="3" style={{ display: "block" }}>
                AI provider configuration
              </Text>

              {/* OAuth providers (e.g. ChatGPT) */}
              {oauthProviders.length > 0 && (
                <Flex direction="column" gap="2" mb="3">
                  {oauthProviders.map((provider) => (
                    <OAuthProviderRow
                      key={provider.id}
                      provider={provider}
                      onChanged={() => void loadProviders()}
                    />
                  ))}
                </Flex>
              )}

              {/* Env-var providers */}
              {envProviders.length > 0 && (
                <Flex direction="column" gap="2">
                  <Text size="1" color="gray" style={{ display: "block" }}>
                    Providers configured via environment variables:
                  </Text>
                  {envProviders.map((provider) => (
                    <EnvProviderRow key={provider.id} provider={provider} />
                  ))}
                </Flex>
              )}

              {oauthProviders.length === 0 && envProviders.length === 0 && (
                <Text size="2" color="gray">
                  No providers available.
                </Text>
              )}
            </Box>
          </Flex>
        )}

        <Flex gap="3" mt="5" justify="end">
          {isSetupMode ? (
            <Button disabled={!canClose} onClick={() => handleOpenChange(false)}>
              {canClose ? "Continue" : "Connect a provider to continue"}
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

interface OAuthProviderRowProps {
  provider: AuthProvider;
  onChanged: () => void;
}

function OAuthProviderRow({ provider, onChanged }: OAuthProviderRowProps) {
  const [isBusy, setIsBusy] = useState(false);
  const connected = provider.status === "connected" || provider.status === "configured";

  const handleConnect = async () => {
    setIsBusy(true);
    try {
      await auth.startOAuthLogin(provider.id);
      onChanged();
    } catch (error) {
      console.error(`Failed to start OAuth login for ${provider.id}:`, error);
    } finally {
      setIsBusy(false);
    }
  };

  const handleLogout = async () => {
    setIsBusy(true);
    try {
      await auth.logout(provider.id);
      onChanged();
    } catch (error) {
      console.error(`Failed to log out of ${provider.id}:`, error);
    } finally {
      setIsBusy(false);
    }
  };

  // Special-case the canonical "ChatGPT" label for the openai-codex provider.
  const label =
    provider.id === "openai-codex"
      ? connected
        ? "ChatGPT"
        : "Connect to ChatGPT"
      : connected
        ? provider.name
        : `Connect to ${provider.name}`;

  return (
    <Card>
      <Flex justify="between" align="center" p="2">
        <Flex align="center" gap="3">
          <Text size="2" weight="medium">
            {provider.name}
          </Text>
          {connected ? (
            <Badge color="green" size="1">
              Connected
            </Badge>
          ) : (
            <Badge color="gray" size="1">
              Not connected
            </Badge>
          )}
        </Flex>
        <Flex gap="2">
          {connected ? (
            <Button variant="soft" color="red" size="1" disabled={isBusy} onClick={handleLogout}>
              {isBusy ? <Spinner /> : "Log out"}
            </Button>
          ) : (
            <Button size="1" disabled={isBusy} onClick={handleConnect}>
              {isBusy ? <Spinner /> : label}
            </Button>
          )}
        </Flex>
      </Flex>
    </Card>
  );
}

interface EnvProviderRowProps {
  provider: AuthProvider;
}

function EnvProviderRow({ provider }: EnvProviderRowProps) {
  const ready = isProviderReady(provider);
  return (
    <Card>
      <Flex justify="between" align="center" p="2">
        <Flex align="center" gap="3">
          <Text size="2" weight="medium" style={{ minWidth: "100px" }}>
            {provider.name}
          </Text>
          {provider.envVar && (
            <Text size="1" color="gray">
              {provider.envVar}
            </Text>
          )}
        </Flex>
        {ready ? (
          <Badge color="green" size="1">
            Configured
          </Badge>
        ) : (
          <Badge color="gray" size="1">
            Not set
          </Badge>
        )}
      </Flex>
    </Card>
  );
}
