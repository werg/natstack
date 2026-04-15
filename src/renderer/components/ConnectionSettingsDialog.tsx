/**
 * ConnectionSettingsDialog — view/edit the remote server URL, token, optional
 * CA cert path / fingerprint. "Save & relaunch" runs `testConnection` first
 * so config errors surface inline without relaunching the app on bad
 * credentials.
 *
 * UX affordances:
 *  - "Test" button validates URL + token + TLS without saving.
 *  - "Fetch fingerprint" button pulls the peer leaf-cert SHA-256 from the
 *    server so the user doesn't have to run openssl by hand.
 *  - "Rotate token" mints a fresh admin token on the server, updates the
 *    local credential store, and relaunches. Requires an existing active
 *    remote connection.
 *  - Trust-on-first-use: if the user enters an https:// URL without a
 *    fingerprint, `testConnection` returns the observed fingerprint and we
 *    show a confirm step before save proceeds.
 *  - Disconnect is now a confirmed destructive action.
 */

import { useEffect, useState } from "react";
import {
  Button,
  Dialog,
  Flex,
  Text,
  TextField,
  Callout,
  Box,
  Code,
} from "@radix-ui/themes";
import { ExclamationTriangleIcon, CheckCircledIcon } from "@radix-ui/react-icons";
import { remoteCred, tokens, type RemoteCredCurrent, type TestConnectionResult } from "../shell/client";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ConnectionSettingsDialog({ open, onOpenChange }: Props) {
  const [current, setCurrent] = useState<RemoteCredCurrent | null>(null);
  const [url, setUrl] = useState("");
  const [token, setToken] = useState("");
  const [caPath, setCaPath] = useState("");
  const [fingerprint, setFingerprint] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pendingTrustPrompt, setPendingTrustPrompt] = useState<string | null>(null);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setInfo(null);
    setPendingTrustPrompt(null);
    setConfirmingDisconnect(false);
    remoteCred.getCurrent().then((c) => {
      setCurrent(c);
      setUrl(c.url ?? "");
      setCaPath(c.caPath ?? "");
      setFingerprint(c.fingerprint ?? "");
      setToken("");
    }).catch((err) => setError(String(err)));
  }, [open]);

  function describeTestError(result: TestConnectionResult): string {
    switch (result.error) {
      case "invalid-url": return `Invalid URL: ${result.message ?? ""}`;
      case "unreachable": return `Server unreachable: ${result.message ?? ""}`;
      case "tls-mismatch": return result.message ?? "TLS fingerprint mismatch";
      case "unauthorized": return "Authentication failed — check the admin token.";
      default: return result.message ?? "Unknown error";
    }
  }

  const runTest = async (): Promise<TestConnectionResult | null> => {
    if (!url || !token) {
      setError("URL and admin token are required.");
      return null;
    }
    try {
      return await remoteCred.testConnection({
        url, token,
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
    const res = await runTest();
    setBusy(false);
    if (!res) return;
    if (res.ok) {
      setInfo(`Connection OK${res.serverVersion ? ` — server version ${res.serverVersion}` : ""}`);
      return;
    }
    if (res.error === "tls-mismatch" && res.observedFingerprint && !fingerprint) {
      // Trust-on-first-use: prompt the user to accept this fingerprint.
      setPendingTrustPrompt(res.observedFingerprint);
      return;
    }
    setError(describeTestError(res));
  };

  const onFetchFingerprint = async () => {
    if (!url) { setError("Enter an https URL first."); return; }
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

  const save = async () => {
    setError(null);
    setInfo(null);
    if (!url || !token) {
      setError("URL and admin token are required.");
      return;
    }
    setBusy(true);
    try {
      // Always test before saving. This catches bad tokens, unreachable
      // servers, and TLS mismatches before the app relaunches into a
      // broken state.
      const res = await runTest();
      if (!res) { setBusy(false); return; }
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
        url, token,
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

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="520px">
        <Dialog.Title>Remote server</Dialog.Title>
        <Dialog.Description size="2" mb="3" color="gray">
          Point this app at a NatStack server running elsewhere. "Save & relaunch" tests the connection first.
        </Dialog.Description>

        {current?.isActive ? (
          <Callout.Root size="1" color="green" mb="3">
            <Callout.Text>Currently connected to {current.url}</Callout.Text>
          </Callout.Root>
        ) : current?.configured ? (
          <Callout.Root size="1" color="amber" mb="3">
            <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
            <Callout.Text>
              Credentials are saved ({current.url}) but app is running in local mode. Relaunch to apply.
            </Callout.Text>
          </Callout.Root>
        ) : null}

        <Flex direction="column" gap="3">
          <Box>
            <Text as="label" size="2" weight="medium">Server URL</Text>
            <TextField.Root
              placeholder="https://my-home-server:3000"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </Box>
          <Box>
            <Text as="label" size="2" weight="medium">
              Admin token {current?.tokenPreview ? <Text color="gray" size="1">(currently: {current.tokenPreview})</Text> : null}
            </Text>
            <TextField.Root
              type="password"
              placeholder={current?.configured ? "••••••••  (re-enter to change)" : "64-char hex token"}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Box>
          <Box>
            <Flex justify="between" align="end" gap="2">
              <Text as="label" size="2" weight="medium">CA certificate path <Text color="gray" size="1">(optional, for self-signed TLS)</Text></Text>
              <Button
                size="1"
                variant="soft"
                disabled={busy}
                onClick={async () => {
                  try {
                    const picked = await remoteCred.pickCaFile();
                    if (picked) setCaPath(picked);
                  } catch (err) { setError((err as Error).message); }
                }}
              >
                Browse…
              </Button>
            </Flex>
            <TextField.Root
              placeholder="/home/you/.config/natstack/server-ca.pem"
              value={caPath}
              onChange={(e) => setCaPath(e.target.value)}
            />
          </Box>
          <Box>
            <Flex justify="between" align="end" gap="2">
              <Text as="label" size="2" weight="medium">TLS fingerprint <Text color="gray" size="1">(optional, SHA-256 colon-hex)</Text></Text>
              <Button size="1" variant="soft" disabled={busy || !url} onClick={onFetchFingerprint}>
                Fetch from server
              </Button>
            </Flex>
            <TextField.Root
              placeholder="AB:CD:..."
              value={fingerprint}
              onChange={(e) => setFingerprint(e.target.value)}
            />
          </Box>

          {pendingTrustPrompt ? (
            <Callout.Root size="1" color="amber">
              <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
              <Callout.Text>
                The server presented this fingerprint: <Code>{pendingTrustPrompt}</Code>. Trust it?
              </Callout.Text>
              <Flex gap="2" mt="2">
                <Button size="1" onClick={acceptTrustPrompt} disabled={busy}>Trust</Button>
                <Button size="1" variant="soft" onClick={() => setPendingTrustPrompt(null)} disabled={busy}>Cancel</Button>
              </Flex>
            </Callout.Root>
          ) : null}

          {info ? (
            <Callout.Root size="1" color="green">
              <Callout.Icon><CheckCircledIcon /></Callout.Icon>
              <Callout.Text>{info}</Callout.Text>
            </Callout.Root>
          ) : null}
          {error ? (
            <Callout.Root size="1" color="red">
              <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
              <Callout.Text>{error}</Callout.Text>
            </Callout.Root>
          ) : null}
        </Flex>

        <Flex justify="between" mt="4" gap="3">
          <Flex gap="2">
            {confirmingDisconnect ? (
              <>
                <Button color="red" disabled={busy} onClick={clearAndRelaunch}>Confirm disconnect</Button>
                <Button variant="soft" color="gray" disabled={busy} onClick={() => setConfirmingDisconnect(false)}>Cancel</Button>
              </>
            ) : (
              <>
                <Button color="red" variant="soft" disabled={busy || !current?.configured} onClick={() => setConfirmingDisconnect(true)}>
                  Disconnect…
                </Button>
                <Button variant="soft" disabled={busy || !current?.isActive} onClick={rotateToken}>
                  Rotate token
                </Button>
              </>
            )}
          </Flex>
          <Flex gap="3">
            <Button variant="soft" color="gray" disabled={busy} onClick={onTestClick}>
              {busy ? "Testing…" : "Test"}
            </Button>
            <Dialog.Close><Button variant="soft" color="gray" disabled={busy}>Cancel</Button></Dialog.Close>
            <Button onClick={save} disabled={busy}>
              {busy ? "Saving…" : "Save & relaunch"}
            </Button>
          </Flex>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
