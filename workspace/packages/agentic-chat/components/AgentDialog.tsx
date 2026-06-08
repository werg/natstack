import { useCallback, useEffect, useMemo, useState } from "react";
import { Box, Button, Callout, Dialog, Flex, Text } from "@radix-ui/themes";
import { ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { isAgentParticipantType } from "@workspace/agentic-core";
import type { AgentSubscriptionConfig, ModelCatalog } from "@workspace/agentic-core";
import { useChatContext } from "../context/ChatContext";
import { AgentConfigForm, type AgentConfigDraft } from "./AgentConfigForm";
import { AgentTypeCard } from "./AgentTypeCard";

export interface AgentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, edit this participant's live settings (model read-only). */
  editParticipantId?: string;
}

type Mode = "add" | "switch" | "edit";

function pickDefaultModel(
  catalog: ModelCatalog | null,
  connected: ReadonlySet<string>,
  defaultModelRef?: string | null
): string {
  const models = catalog?.models ?? [];
  return (
    (defaultModelRef && models.some((m) => m.ref === defaultModelRef) ? defaultModelRef : null) ??
    models.find((m) => m.recommended && connected.has(m.ref))?.ref ??
    models.find((m) => connected.has(m.ref))?.ref ??
    models.find((m) => m.recommended)?.ref ??
    models[0]?.ref ??
    ""
  );
}

function draftToConfig(draft: AgentConfigDraft): AgentSubscriptionConfig {
  const config: AgentSubscriptionConfig = {};
  if (draft.model) config.model = draft.model;
  if (draft.thinkingLevel) config.thinkingLevel = draft.thinkingLevel;
  if (draft.approvalLevel !== undefined) config.approvalLevel = draft.approvalLevel;
  if (draft.respondPolicy) config.respondPolicy = draft.respondPolicy;
  if (draft.respondFrom && draft.respondFrom.length > 0) config.respondFrom = draft.respondFrom;
  if (draft.handle) config["handle"] = draft.handle;
  if (draft.systemPrompt) config.systemPrompt = draft.systemPrompt;
  return config;
}

export function AgentDialog({ open, onOpenChange, editParticipantId }: AgentDialogProps) {
  const ctx = useChatContext();
  const {
    messages,
    participants,
    availableAgents = [],
    modelCatalog = null,
    defaultModelRef,
    connectedModelRefs,
    onAddAgent,
    onReplaceAgent,
    onConnectProvider,
    onCallMethodResult,
  } = ctx;

  const connectedRefs = useMemo(() => new Set(connectedModelRefs ?? []), [connectedModelRefs]);

  const agentParticipants = useMemo(
    () => Object.values(participants).filter((p) => isAgentParticipantType(p.metadata.type)),
    [participants]
  );

  const isSwitch = !editParticipantId && messages.length === 0 && agentParticipants.length === 1;
  const mode: Mode = editParticipantId ? "edit" : isSwitch ? "switch" : "add";
  const targetParticipantId =
    editParticipantId ?? (isSwitch ? agentParticipants[0]?.id : undefined);
  const targetParticipant = targetParticipantId ? participants[targetParticipantId] : undefined;

  // Reactiveness matters only when the channel will hold more than one agent.
  const showReactiveness =
    mode === "add" ? agentParticipants.length >= 1 : mode === "edit" && agentParticipants.length > 1;
  const showHandle = mode === "add" && showReactiveness;

  const otherParticipants = useMemo(
    () =>
      Object.values(participants)
        .filter((p) => p.id !== targetParticipantId)
        .map((p) => ({
          id: p.id,
          label: (p.metadata.handle as string) || (p.metadata.name as string) || p.id,
        })),
    [participants, targetParticipantId]
  );

  const showGallery = mode !== "edit" && availableAgents.length > 1;
  const [agentId, setAgentId] = useState<string | undefined>(availableAgents[0]?.id);
  const [step, setStep] = useState<"type" | "config">(showGallery ? "type" : "config");
  const [draft, setDraft] = useState<AgentConfigDraft>({ model: "" });
  const [modelTouched, setModelTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Initialize when the dialog opens.
  useEffect(() => {
    if (!open) return;
    setError(null);
    setBusy(false);
    setStep(showGallery ? "type" : "config");
    setAgentId(availableAgents[0]?.id);
    setModelTouched(false);

    if (mode === "add") {
      setDraft({
        model: pickDefaultModel(modelCatalog, connectedRefs, defaultModelRef),
        approvalLevel: 2,
        respondPolicy: showReactiveness ? "mentioned" : undefined,
        handle: availableAgents[0]?.proposedHandle,
      });
      return;
    }

    // switch/edit: prefill from the target agent's current settings.
    let cancelled = false;
    setDraft({ model: "", handle: targetParticipant?.metadata.handle as string | undefined });
    void (async () => {
      if (!targetParticipantId) return;
      try {
        const settings = (await onCallMethodResult(
          targetParticipantId,
          "getAgentSettings",
          {}
        )) as {
          model?: { value: string };
          thinkingLevel?: { value: string };
          approvalLevel?: { value: number };
          respondPolicy?: { value: string };
          respondFrom?: { value: string[] };
        } | null;
        if (cancelled || !settings) return;
        setDraft({
          model: settings.model?.value ?? "",
          thinkingLevel: settings.thinkingLevel?.value as AgentConfigDraft["thinkingLevel"],
          approvalLevel: settings.approvalLevel?.value as AgentConfigDraft["approvalLevel"],
          respondPolicy: settings.respondPolicy?.value as AgentConfigDraft["respondPolicy"],
          respondFrom: settings.respondFrom?.value,
          handle: targetParticipant?.metadata.handle as string | undefined,
        });
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || mode !== "add" || modelTouched) return;
    const nextModel = pickDefaultModel(modelCatalog, connectedRefs, defaultModelRef);
    if (!nextModel) return;
    setDraft((current) =>
      current.model === nextModel ? current : { ...current, model: nextModel }
    );
  }, [open, mode, modelTouched, modelCatalog, connectedRefs, defaultModelRef]);

  const selectedModel = useMemo(
    () => modelCatalog?.models.find((m) => m.ref === draft.model) ?? null,
    [modelCatalog, draft.model]
  );
  const needsConnect =
    !!selectedModel && !connectedRefs.has(selectedModel.ref) && selectedModel.connectable;

  const verb = mode === "switch" ? "Switch" : mode === "edit" ? "Save" : "Add";
  const title = mode === "switch" ? "Switch agent" : mode === "edit" ? "Agent settings" : "Add agent";

  const finish = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      if (needsConnect && selectedModel && onConnectProvider) {
        const res = await onConnectProvider(selectedModel.provider, selectedModel.baseUrl);
        if (!res.ok) {
          setError(res.error ?? "Failed to connect provider");
          setBusy(false);
          return;
        }
      }
      const config = draftToConfig(draft);
      if (mode === "add") {
        onAddAgent?.(agentId, config);
      } else if (mode === "switch" && targetParticipantId) {
        // Reuse the existing handle for a stable identity.
        config["handle"] = (targetParticipant?.metadata.handle as string) ?? config["handle"];
        await onReplaceAgent?.(targetParticipantId, agentId, config);
      } else if (mode === "edit" && targetParticipantId) {
        // Apply live settings (model is handled by "Restart with this model").
        await onCallMethodResult(targetParticipantId, "setApprovalLevel", {
          level: draft.approvalLevel ?? 2,
        });
        if (draft.thinkingLevel) {
          await onCallMethodResult(targetParticipantId, "setThinkingLevel", {
            level: draft.thinkingLevel,
          });
        }
        if (draft.respondPolicy) {
          await onCallMethodResult(targetParticipantId, "setRespondPolicy", {
            policy: draft.respondPolicy,
            from: draft.respondFrom,
          });
        }
      }
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [
    needsConnect,
    selectedModel,
    onConnectProvider,
    draft,
    mode,
    agentId,
    targetParticipantId,
    targetParticipant,
    onAddAgent,
    onReplaceAgent,
    onCallMethodResult,
    onOpenChange,
  ]);

  const restartWithModel = useCallback(async () => {
    if (!targetParticipantId) return;
    setBusy(true);
    setError(null);
    try {
      if (needsConnect && selectedModel && onConnectProvider) {
        const res = await onConnectProvider(selectedModel.provider, selectedModel.baseUrl);
        if (!res.ok) {
          setError(res.error ?? "Failed to connect provider");
          setBusy(false);
          return;
        }
      }
      const config = draftToConfig(draft);
      config["handle"] = (targetParticipant?.metadata.handle as string) ?? config["handle"];
      await onReplaceAgent?.(targetParticipantId, undefined, config);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [
    targetParticipantId,
    needsConnect,
    selectedModel,
    onConnectProvider,
    draft,
    targetParticipant,
    onReplaceAgent,
    onOpenChange,
  ]);

  const primaryLabel = needsConnect ? `Connect & ${verb.toLowerCase()}` : verb;
  const canSubmit = !!draft.model && !busy;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content style={{ width: "min(460px, calc(100vw - 24px))", maxHeight: "min(85dvh, 680px)" }}>
        <Dialog.Title>{title}</Dialog.Title>
        <Dialog.Description size="2" color="gray" mb="3">
          {mode === "switch"
            ? "Replace the current agent before the conversation starts."
            : mode === "edit"
              ? "Tune this agent's behavior. Model changes require a restart."
              : "Add another agent to this conversation."}
        </Dialog.Description>

        {error && (
          <Callout.Root color="red" mb="3" size="1">
            <Callout.Icon>
              <ExclamationTriangleIcon />
            </Callout.Icon>
            <Callout.Text>{error}</Callout.Text>
          </Callout.Root>
        )}

        {step === "type" ? (
          <Flex direction="column" gap="2">
            {availableAgents.map((a) => (
              <AgentTypeCard
                key={`${a.id}:${a.className}`}
                agent={a}
                selected={a.id === agentId}
                onSelect={() => {
                  setAgentId(a.id);
                  setDraft((d) => ({ ...d, handle: showHandle ? a.proposedHandle : d.handle }));
                }}
              />
            ))}
            <Flex gap="3" mt="3" justify="end">
              <Dialog.Close>
                <Button variant="soft" color="gray">
                  Cancel
                </Button>
              </Dialog.Close>
              <Button onClick={() => setStep("config")} disabled={!agentId}>
                Continue
              </Button>
            </Flex>
          </Flex>
        ) : (
          <Box>
            <AgentConfigForm
              catalog={modelCatalog}
              connectedRefs={connectedRefs}
              value={draft}
              onChange={(next) => {
                if (next.model !== draft.model) setModelTouched(true);
                setDraft(next);
              }}
              modelEditable={mode !== "edit"}
              showReactiveness={showReactiveness}
              showHandle={showHandle}
              participants={otherParticipants}
            />

            {mode === "edit" && (
              <Box mt="3">
                <Button
                  variant="soft"
                  color="orange"
                  size="1"
                  onClick={restartWithModel}
                  disabled={busy || !draft.model}
                >
                  Restart with this model
                </Button>
              </Box>
            )}

            <Flex gap="3" mt="4" justify="between" align="center">
              {showGallery ? (
                <Button variant="ghost" color="gray" onClick={() => setStep("type")} disabled={busy}>
                  Back
                </Button>
              ) : (
                <span />
              )}
              <Flex gap="3">
                <Dialog.Close>
                  <Button variant="soft" color="gray" disabled={busy}>
                    Cancel
                  </Button>
                </Dialog.Close>
                <Button onClick={finish} disabled={!canSubmit} loading={busy}>
                  {mode === "edit" ? "Save" : primaryLabel}
                </Button>
              </Flex>
            </Flex>
            {needsConnect && selectedModel && (
              <Text size="1" color="amber" as="p" mt="2">
                {selectedModel.provider} isn't connected yet — you'll be asked to sign in.
              </Text>
            )}
            {selectedModel && !selectedModel.connectable && !connectedRefs.has(selectedModel.ref) && (
              <Text size="1" color="gray" as="p" mt="2">
                Connecting {selectedModel.provider} isn't supported here yet.
              </Text>
            )}
          </Box>
        )}
      </Dialog.Content>
    </Dialog.Root>
  );
}
