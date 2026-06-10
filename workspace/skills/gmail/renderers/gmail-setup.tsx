import { Badge, Box, Button, Callout, Flex, Switch, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon, GearIcon, ReloadIcon } from "@radix-ui/react-icons";
import { useState } from "react";
import type { GmailSetupState } from "@workspace/gmail/card-types";

type GmailSetupCardState = Partial<GmailSetupState> & { status: GmailSetupState["status"] };

interface GmailChat {
  callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown>;
}

export function Pill({ state }: { state: GmailSetupCardState }) {
  const auth = state.auth?.status ?? "unknown";
  return (
    <Flex align="center" gap="1">
      <GearIcon />
      <Text size="1" weight="medium">Gmail setup</Text>
      <Badge size="1" color={auth === "ok" ? "green" : auth === "reconnect-required" ? "red" : "gray"}>
        {auth === "ok" ? "Connected" : auth === "reconnect-required" ? "Reconnect" : "Unknown"}
      </Badge>
      {state.status === "onboarding" ? <Badge size="1" color="amber">Setup needed</Badge> : null}
    </Flex>
  );
}

export default function GmailSetup({
  state,
  expanded,
  chat,
}: {
  state: GmailSetupCardState;
  expanded: boolean;
  chat: GmailChat;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconnectResult, setReconnectResult] = useState<string | null>(null);

  if (!expanded) return <Pill state={state} />;

  async function run(key: string, method: string, args: unknown = {}): Promise<unknown> {
    setBusy(key);
    setError(null);
    try {
      return await chat.callMethodByHandle("gmail", method, args);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  async function reconnect() {
    setReconnectResult(null);
    const result = (await run("reconnect", "reconnect")) as
      | { ok: boolean; auth?: { status?: string }; error?: string }
      | undefined;
    if (!result) return;
    setReconnectResult(
      result.auth?.status === "ok"
        ? "Connection verified."
        : `Still disconnected${result.error ? `: ${result.error}` : "."}`
    );
  }

  const auth = state.auth?.status ?? "unknown";
  const rules = state.attentionRules ?? [];
  const pollMinutes = state.pollIntervalMs ? Math.round(state.pollIntervalMs / 60_000) : null;
  const lastSynced = state.lastSyncAt ? new Date(state.lastSyncAt).toLocaleString() : "never";

  return (
    <Flex direction="column" gap="3">
      <Flex align="center" justify="between" gap="2" wrap="wrap">
        <Flex align="center" gap="2">
          <GearIcon />
          <Text size="3" weight="bold">Gmail setup</Text>
          <Badge color={auth === "ok" ? "green" : auth === "reconnect-required" ? "red" : "gray"} variant="soft">
            {auth === "ok"
              ? "Connected"
              : auth === "reconnect-required"
                ? "Reconnect required"
                : "Connection unknown"}
          </Badge>
        </Flex>
        <Button size="1" variant="soft" disabled={busy !== null} onClick={() => void reconnect()}>
          <ReloadIcon /> {busy === "reconnect" ? "Verifying" : "Reconnect"}
        </Button>
      </Flex>

      <Text size="1" color="gray">
        {state.email ?? "Gmail account"} - last synced {lastSynced}
        {pollMinutes ? ` - polls every ${pollMinutes} min` : ""}
      </Text>

      {state.addressBook ? (
        <Text size="1" color="gray">
          Address book: history-derived ({state.addressBook.knownPeople} people) - Google
          contacts:{" "}
          {state.addressBook.googleContacts === "available"
            ? "available"
            : state.addressBook.googleContacts === "unavailable"
              ? "unavailable — reconnect Google to enable it"
              : "not checked yet"}
        </Text>
      ) : null}

      {reconnectResult ? <Text size="1" color="gray">{reconnectResult}</Text> : null}
      {state.lastError || error ? (
        <Callout.Root color="red" size="1">
          <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
          <Callout.Text>{error ?? state.lastError}</Callout.Text>
        </Callout.Root>
      ) : null}

      {state.status === "onboarding" ? (
        <Callout.Root color="amber" size="1">
          <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
          <Callout.Text>
            First-run setup is not finished. Tell the Gmail agent what kinds of incoming mail it
            should watch for, or pick a watch rule from the inbox card.
          </Callout.Text>
        </Callout.Root>
      ) : null}
      {state.setupSummary ? <Text size="1" color="gray">{state.setupSummary}</Text> : null}

      <Flex direction="column" gap="2">
        <Text size="2" weight="medium">Attention rules</Text>
        {rules.length === 0 ? (
          <Text size="2" color="gray">No wake rules installed. Incoming mail will not wake the agent.</Text>
        ) : (
          rules.map((rule) => (
            <Flex
              key={rule.id}
              align="center"
              justify="between"
              gap="2"
              style={{ border: "1px solid var(--gray-a5)", borderRadius: 6, padding: "8px" }}
            >
              <Box style={{ minWidth: 0 }}>
                <Text size="2" weight="medium" style={{ wordBreak: "break-word" }}>{rule.name}</Text>
                <Text size="1" color="gray" style={{ display: "block" }}>
                  priority {rule.priority}
                </Text>
              </Box>
              <Switch
                checked={rule.enabled}
                disabled={busy !== null}
                onCheckedChange={(checked) =>
                  void run(`rule:${rule.id}`, "setAttentionRuleEnabled", {
                    id: rule.id,
                    enabled: checked === true,
                  })
                }
              />
            </Flex>
          ))
        )}
      </Flex>
    </Flex>
  );
}
