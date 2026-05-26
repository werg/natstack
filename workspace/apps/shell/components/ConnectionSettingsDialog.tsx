import { useEffect, useState } from "react";
import { Button, Dialog, Flex, Text, TextField, Callout, Box, Code, Tabs } from "@radix-ui/themes";
import { ExclamationTriangleIcon, CheckCircledIcon } from "@radix-ui/react-icons";
import { parseConnectLink } from "@natstack/shared/connect";
import {
  incomingPairLink,
  remoteCred,
  tokens,
  type DiscoveredServer,
  type RemoteCredCurrent,
  type TestConnectionResult,
} from "../shell/client";
import { PairedDevicesSection } from "./PairedDevicesSection";
import { AppUpdatesSection } from "./AppUpdatesSection";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectionSettingsDialog({ open, onOpenChange }: Props) {
  const [current, setCurrent] = useState<RemoteCredCurrent | null>(null);
  const [tab, setTab] = useState("pair");
  const [url, setUrl] = useState("");
  const [pairingCode, setPairingCode] = useState("");
  const [deviceLabel, setDeviceLabel] = useState("");
  const [token, setToken] = useState("");
  const [caPath, setCaPath] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pendingTrustPrompt, setPendingTrustPrompt] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
  const [serversOpen, setServersOpen] = useState(false);
  const [servers, setServers] = useState<DiscoveredServer[]>([]);
  const [discovering, setDiscovering] = useState(false);

  useEffect(() => {
    const apply = (link: { url: string; code: string }) => {
      setUrl(link.url);
      setPairingCode(link.code);
      setTab("pair");
      onOpenChange(true);
    };
    void incomingPairLink.getPending().then((link) => {
      if (link) apply(link);
    });
    return incomingPairLink.onLink(apply);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setInfo(null);
    setPendingTrustPrompt(null);
    setConfirmingDisconnect(false);
    remoteCred
      .getCurrent()
      .then((c) => {
        setCurrent(c);
        if (!url) setUrl(c.url ?? "");
        setCaPath(c.caPath ?? "");
        setFingerprint(c.fingerprint ?? "");
        setToken("");
        if (c.bootstrap === "device" && !c.isActive) setTab("pair");
      })
      .catch((err) => setError(String(err)));
  }, [open]);

  function describeTestError(result: TestConnectionResult): string {
    switch (result.error) {
      case "invalid-url":
        return `Invalid URL: ${result.message ?? ""}`;
      case "unreachable":
        return `Server unreachable: ${result.message ?? ""}`;
      case "tls-mismatch":
        return result.message ?? "TLS fingerprint mismatch";
      case "unauthorized":
        return "Authentication failed — check the credential.";
      default:
        return result.message ?? "Unknown error";
    }
  }

  const onPasteLink = () => {
    const raw = window.prompt("Paste natstack:// pairing link");
    if (!raw) return;
    const parsed = parseConnectLink(raw);
    if (parsed.kind === "error") {
      setError(parsed.reason);
      return;
    }
    setUrl(parsed.url);
    setPairingCode(parsed.code);
    setTab("pair");
  };

  const onFetchFingerprint = async () => {
    if (!url) {
      setError("Enter an https URL first.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const fp = await remoteCred.fetchPeerFingerprint(url);
      setFingerprint(fp);
      setInfo(`Fetched fingerprint: ${fp}`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const acceptTrustPrompt = () => {
    if (pendingTrustPrompt) setFingerprint(pendingTrustPrompt);
    setPendingTrustPrompt(null);
    setInfo("Fingerprint accepted. Click Save & relaunch when ready.");
  };

  const savePairing = async () => {
    setError(null);
    setInfo(null);
    if (!url || !pairingCode) {
      setError("URL and pairing code are required.");
      return;
    }
    setBusy(true);
    try {
      const res = await remoteCred.exchangePairingCode({
        url,
        code: pairingCode,
        label: deviceLabel || undefined,
        caPath: caPath || undefined,
        fingerprint: fingerprint || undefined,
      });
      if (!res.ok) {
        if (res.error === "tls-mismatch" && res.observedFingerprint && !fingerprint) {
          setPendingTrustPrompt(res.observedFingerprint);
        } else {
          setError(describeTestError(res));
        }
        setBusy(false);
      }
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const testAdmin = async (): Promise<TestConnectionResult | null> => {
    if (!url || !token) {
      setError("URL and admin token are required.");
      return null;
    }
    try {
      return await remoteCred.testConnection({
        url,
        token,
        caPath: caPath || undefined,
        fingerprint: fingerprint || undefined,
      });
    } catch (err) {
      setError((err as Error).message);
      return null;
    }
  };

  const onTestClick = async () => {
    setBusy(true);
    setError(null);
    setInfo(null);
    setPendingTrustPrompt(null);
    const res = await testAdmin();
    setBusy(false);
    if (!res) return;
    if (res.ok) {
      setInfo(`Connection OK${res.serverVersion ? ` — server version ${res.serverVersion}` : ""}`);
      return;
    }
    if (res.error === "tls-mismatch" && res.observedFingerprint && !fingerprint) {
      setPendingTrustPrompt(res.observedFingerprint);
      return;
    }
    setError(describeTestError(res));
  };

  const saveAdmin = async () => {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const res = await testAdmin();
      if (!res) {
        setBusy(false);
        return;
      }
      if (!res.ok) {
        if (res.error === "tls-mismatch" && res.observedFingerprint && !fingerprint) {
          setPendingTrustPrompt(res.observedFingerprint);
        } else {
          setError(describeTestError(res));
        }
        setBusy(false);
        return;
      }
      await remoteCred.save({
        url,
        token,
        caPath: caPath || undefined,
        fingerprint: fingerprint || undefined,
      });
      await remoteCred.relaunch();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const rotateToken = async () => {
    setError(null);
    setInfo(null);
    if (!current?.isActive) {
      setError("Rotate is only available while connected to a remote server.");
      return;
    }
    if (current.bootstrap === "device") {
      setError("This connection has no saved admin token. Re-pair or use the Admin token tab.");
      return;
    }
    setBusy(true);
    try {
      const newToken = await tokens.rotateAdmin();
      if (!url) {
        setError("No URL on record to persist the new token — re-enter and save first.");
        setBusy(false);
        return;
      }
      await remoteCred.save({
        url,
        token: newToken,
        caPath: caPath || undefined,
        fingerprint: fingerprint || undefined,
      });
      await remoteCred.relaunch();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const clearAndRelaunch = async () => {
    setBusy(true);
    try {
      await remoteCred.clear();
      await remoteCred.relaunch();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const discoverServers = async () => {
    setDiscovering(true);
    setError(null);
    try {
      setServers(await remoteCred.discoverServers());
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setDiscovering(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="680px">
        <Dialog.Title>Remote server</Dialog.Title>
        <Dialog.Description size="2" mb="3" color="gray">
          Pair this app with a NatStack server running elsewhere.
        </Dialog.Description>

        {current?.isActive ? (
          <Callout.Root size="1" color="green" mb="3">
            <Callout.Text>
              Currently connected to {current.url}
              {current.bootstrap === "hybrid" ? " with saved admin token" : ""}
            </Callout.Text>
          </Callout.Root>
        ) : current?.configured ? (
          <Callout.Root size="1" color={current.bootstrap === "device" ? "red" : "amber"} mb="3">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>
              {current.bootstrap === "device"
                ? "Device credential rejected or inactive — re-pair from the server."
                : `Credentials are saved (${current.url}) but app is running in local mode. Relaunch to apply.`}
            </Callout.Text>
          </Callout.Root>
        ) : null}

        <Tabs.Root value={tab} onValueChange={setTab}>
          <Tabs.List mb="3">
            <Tabs.Trigger value="pair">Pair with code</Tabs.Trigger>
            <Tabs.Trigger value="admin">Admin token</Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="pair">
            <Flex direction="column" gap="3">
              <ServerDiscovery
                open={serversOpen}
                setOpen={setServersOpen}
                servers={servers}
                busy={discovering}
                onRefresh={discoverServers}
                onPick={(serverUrl) => setUrl(serverUrl)}
              />
              <UrlFields
                url={url}
                setUrl={setUrl}
                caPath={caPath}
                setCaPath={setCaPath}
                fingerprint={fingerprint}
                setFingerprint={setFingerprint}
                busy={busy}
                onFetchFingerprint={onFetchFingerprint}
              />
              <Box>
                <Flex justify="between" align="end">
                  <Text as="label" size="2" weight="medium">
                    Pairing code
                  </Text>
                  <Button size="1" variant="soft" disabled={busy} onClick={onPasteLink}>
                    Paste link
                  </Button>
                </Flex>
                <TextField.Root
                  placeholder="Code from pnpm pair"
                  value={pairingCode}
                  onChange={(e) => setPairingCode(e.target.value)}
                />
              </Box>
              <Box>
                <Text as="label" size="2" weight="medium">
                  Device label{" "}
                  <Text color="gray" size="1">
                    (optional)
                  </Text>
                </Text>
                <TextField.Root
                  placeholder="Electron on this laptop"
                  value={deviceLabel}
                  onChange={(e) => setDeviceLabel(e.target.value)}
                />
              </Box>
            </Flex>
          </Tabs.Content>

          <Tabs.Content value="admin">
            <Flex direction="column" gap="3">
              <UrlFields
                url={url}
                setUrl={setUrl}
                caPath={caPath}
                setCaPath={setCaPath}
                fingerprint={fingerprint}
                setFingerprint={setFingerprint}
                busy={busy}
                onFetchFingerprint={onFetchFingerprint}
              />
              <Box>
                <Text as="label" size="2" weight="medium">
                  Admin token{" "}
                  {current?.tokenPreview ? (
                    <Text color="gray" size="1">
                      (currently: {current.tokenPreview})
                    </Text>
                  ) : null}
                </Text>
                <TextField.Root
                  type="password"
                  placeholder={
                    current?.configured ? "••••••••  (re-enter to change)" : "64-char hex token"
                  }
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                />
              </Box>
            </Flex>
          </Tabs.Content>
        </Tabs.Root>

        <TrustFingerprintPrompt
          fingerprint={pendingTrustPrompt}
          busy={busy}
          onTrust={acceptTrustPrompt}
          onCancel={() => setPendingTrustPrompt(null)}
        />

        {info ? (
          <Callout.Root size="1" color="green" mt="3">
            <Callout.Icon>
              <CheckCircledIcon />
            </Callout.Icon>
            <Callout.Text>{info}</Callout.Text>
          </Callout.Root>
        ) : null}
        {error ? (
          <Callout.Root size="1" color="red" mt="3">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        ) : null}

        {current?.isActive && current.bootstrap !== "none" ? (
          <PairedDevicesSection currentDeviceId={current.deviceId} />
        ) : null}
        <AppUpdatesSection />

        <Flex justify="between" mt="4" gap="3">
          <Flex gap="2">
            {confirmingDisconnect ? (
              <>
                <Button color="red" disabled={busy} onClick={clearAndRelaunch}>
                  Confirm disconnect
                </Button>
                <Button
                  variant="soft"
                  color="gray"
                  disabled={busy}
                  onClick={() => setConfirmingDisconnect(false)}
                >
                  Cancel
                </Button>
              </>
            ) : (
              <>
                <Button
                  color="red"
                  variant="soft"
                  disabled={busy || !current?.configured}
                  onClick={() => setConfirmingDisconnect(true)}
                >
                  Disconnect…
                </Button>
                <Button
                  variant="soft"
                  disabled={busy || !current?.isActive || current.bootstrap === "device"}
                  onClick={rotateToken}
                >
                  Rotate token
                </Button>
              </>
            )}
          </Flex>
          <Flex gap="3">
            {tab === "admin" ? (
              <Button variant="soft" color="gray" disabled={busy} onClick={onTestClick}>
                {busy ? "Testing…" : "Test"}
              </Button>
            ) : null}
            <Dialog.Close>
              <Button variant="soft" color="gray" disabled={busy}>
                Cancel
              </Button>
            </Dialog.Close>
            <Button onClick={tab === "pair" ? savePairing : saveAdmin} disabled={busy}>
              {busy ? "Saving…" : "Save & relaunch"}
            </Button>
          </Flex>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function UrlFields(props: {
  url: string;
  setUrl: (value: string) => void;
  caPath: string;
  setCaPath: (value: string) => void;
  fingerprint: string;
  setFingerprint: (value: string) => void;
  busy: boolean;
  onFetchFingerprint: () => void;
}) {
  return (
    <>
      <Box>
        <Text as="label" size="2" weight="medium">
          Server URL
        </Text>
        <TextField.Root
          placeholder="https://my-server.tailnet.ts.net"
          value={props.url}
          onChange={(e) => props.setUrl(e.target.value)}
        />
      </Box>
      <Box>
        <Flex justify="between" align="end" gap="2">
          <Text as="label" size="2" weight="medium">
            CA certificate path{" "}
            <Text color="gray" size="1">
              (optional)
            </Text>
          </Text>
          <Button
            size="1"
            variant="soft"
            disabled={props.busy}
            onClick={async () => {
              const picked = await remoteCred.pickCaFile();
              if (picked) props.setCaPath(picked);
            }}
          >
            Browse…
          </Button>
        </Flex>
        <TextField.Root
          placeholder="/home/you/.config/natstack/server-ca.pem"
          value={props.caPath}
          onChange={(e) => props.setCaPath(e.target.value)}
        />
      </Box>
      <Box>
        <Flex justify="between" align="end" gap="2">
          <Text as="label" size="2" weight="medium">
            TLS fingerprint{" "}
            <Text color="gray" size="1">
              (optional)
            </Text>
          </Text>
          <Button
            size="1"
            variant="soft"
            disabled={props.busy || !props.url}
            onClick={props.onFetchFingerprint}
          >
            Fetch from server
          </Button>
        </Flex>
        <TextField.Root
          placeholder="AB:CD:..."
          value={props.fingerprint}
          onChange={(e) => props.setFingerprint(e.target.value)}
        />
      </Box>
    </>
  );
}

function TrustFingerprintPrompt(props: {
  fingerprint: string | null;
  busy: boolean;
  onTrust: () => void;
  onCancel: () => void;
}) {
  if (!props.fingerprint) return null;
  return (
    <Callout.Root size="1" color="amber" mt="3">
      <Callout.Icon>
        <ExclamationTriangleIcon />
      </Callout.Icon>
      <Callout.Text>
        The server presented this fingerprint: <Code>{props.fingerprint}</Code>. Trust it?
      </Callout.Text>
      <Flex gap="2" mt="2">
        <Button size="1" onClick={props.onTrust} disabled={props.busy}>
          Trust
        </Button>
        <Button size="1" variant="soft" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </Button>
      </Flex>
    </Callout.Root>
  );
}

function ServerDiscovery(props: {
  open: boolean;
  setOpen: (open: boolean) => void;
  servers: DiscoveredServer[];
  busy: boolean;
  onRefresh: () => void;
  onPick: (url: string) => void;
}) {
  return (
    <Box>
      <Button
        size="1"
        variant="soft"
        onClick={() => {
          const next = !props.open;
          props.setOpen(next);
          if (next && props.servers.length === 0) void props.onRefresh();
        }}
      >
        Servers on your tailnet
      </Button>
      {props.open ? (
        <Flex direction="column" gap="2" mt="2">
          <Flex justify="between" align="center">
            <Text size="1" color="gray">
              {props.servers.length === 0 && !props.busy
                ? "No NatStack servers found on your tailnet. Run pnpm pair on the server."
                : "Discovered NatStack servers"}
            </Text>
            <Button size="1" variant="soft" disabled={props.busy} onClick={props.onRefresh}>
              {props.busy ? "Scanning…" : "Refresh"}
            </Button>
          </Flex>
          {props.servers.map((server) => (
            <Button
              key={server.url}
              size="1"
              variant="surface"
              color="gray"
              onClick={() => props.onPick(server.url)}
            >
              {server.url}
            </Button>
          ))}
        </Flex>
      ) : null}
    </Box>
  );
}
