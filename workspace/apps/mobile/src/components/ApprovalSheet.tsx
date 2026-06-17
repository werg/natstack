import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentType,
} from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  Dimensions,
  Easing,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import ReactNativeHapticFeedback from "react-native-haptic-feedback";
import type {
  ApprovalDecision,
  PendingApproval,
  PendingCapabilityApproval,
  PendingClientConfigApproval,
  PendingCredentialApproval,
  PendingCredentialInputApproval,
  PendingDeviceCodeApproval,
  PendingUnitBatchApproval,
  PendingUserlandApproval,
  UserlandApprovalOption,
} from "@natstack/shared/approvals";
import {
  type ApprovalAttribution,
  formatAccount,
  formatCredentialInputAudienceSummary,
  formatInjection,
  getApprovalAttribution,
  getApprovalCopy,
  getStandardActionCopy,
  getUnitBatchActionCopy,
  originForUrl,
  shouldOpenApprovalDetails,
} from "@natstack/shared/approvalCopy";
import { useAtomValue } from "jotai";
import { themeColorsAtom } from "../state/themeAtoms";

declare const require: (id: string) => unknown;

type IconProps = { size?: number; color?: string; strokeWidth?: number };
type IconComponent = ComponentType<IconProps>;
type IconModule = Record<string, IconComponent | undefined>;

let lucideIcons: IconModule = {};
try {
  lucideIcons = require("lucide-react-native") as IconModule;
} catch {
  lucideIcons = {};
}

function fallbackIcon(glyph: string): IconComponent {
  return function FallbackIcon({ size = 16, color }: IconProps) {
    return <Text style={{ color, fontSize: size, lineHeight: size }}>{glyph}</Text>;
  };
}

function icon(name: string, glyph: string): IconComponent {
  return lucideIcons[name] ?? fallbackIcon(glyph);
}

const AlertTriangle = icon("AlertTriangle", "!");
const ArrowRight = icon("ArrowRight", ">");
const CheckCircle2 = icon("CheckCircle2", "+");
const ChevronDown = icon("ChevronDown", "v");
const ChevronLeft = icon("ChevronLeft", "<");
const ChevronRight = icon("ChevronRight", ">");
const ExternalLink = icon("ExternalLink", ">");
const Globe = icon("Globe", "@");
const Info = icon("Info", "i");
const LayoutPanelTop = icon("LayoutPanelTop", "#");
const Lock = icon("Lock", "*");
const Settings2 = icon("Settings2", "=");
const User = icon("User", "u");
const Workflow = icon("Workflow", "~");
const X = icon("X", "x");
const XCircle = icon("XCircle", "x");

interface CallerInfo {
  /** Friendly user-visible label — panel title, worker source basename, etc. */
  label: string;
  /** Caller kind, formatted for display ("Panel" / "Worker" / "Service"). */
  kindLabel: string;
  /** Caller kind as accepted by the approval payload. */
  kind: "panel" | "app" | "worker" | "do" | "system";
  /** Set when this caller refers to a panel that exists in the live tree. */
  panelId?: string;
  /** Truncated id, retained for the expandable details panel. */
  shortId: string;
}

function basename(path: string): string {
  if (!path) return "";
  const trimmed = path.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function prettifyId(callerId: string): string {
  return callerId.replace(/^(do-service:|do:|worker:|panel:)/, "");
}

function resolveCallerInfo(approval: PendingApproval): CallerInfo {
  const shortId = truncateId(approval.callerId);
  const serverTitle = approval.callerTitle?.trim() || undefined;
  if (approval.callerKind === "panel") {
    return {
      label: serverTitle ?? prettifyId(approval.callerId),
      kindLabel: "Panel",
      kind: "panel",
      panelId: approval.callerId,
      shortId,
    };
  }
  if (approval.callerKind === "worker") {
    const fromRepo = basename(approval.repoPath);
    return {
      label: serverTitle ?? fromRepo ?? prettifyId(approval.callerId),
      kindLabel: "Worker",
      kind: "worker",
      shortId,
    };
  }
  if (approval.callerKind === "app") {
    const fromRepo = basename(approval.repoPath);
    return {
      label: serverTitle ?? fromRepo ?? prettifyId(approval.callerId),
      kindLabel: "App",
      kind: "app",
      shortId,
    };
  }
  if (approval.callerKind === "system") {
    return {
      label: serverTitle ?? "Workspace",
      kindLabel: "Workspace",
      kind: "system",
      shortId,
    };
  }
  const id = prettifyId(approval.callerId);
  const segments = id.split(":");
  return {
    label: serverTitle ?? segments[segments.length - 1] ?? id,
    kindLabel: "Service",
    kind: "do",
    shortId,
  };
}

export interface ApprovalSheetProps {
  approvals: PendingApproval[];
  onResolve: (approvalId: string, decision: ApprovalDecision) => Promise<void> | void;
  onSubmitClientConfig: (
    approvalId: string,
    values: Record<string, string>
  ) => Promise<void> | void;
  onSubmitCredentialInput: (
    approvalId: string,
    values: Record<string, string>
  ) => Promise<void> | void;
  onResolveUserland: (approvalId: string, choice: string | "dismiss") => Promise<void> | void;
  /**
   * Optional. When supplied and the current approval comes from a panel,
   * the caller chip becomes touchable and invokes this with the panel id.
   * Mobile wires it to `activatePanel` so the user can jump to the source.
   */
  onNavigateToPanel?: (panelId: string) => void;
}

type PendingAction =
  | ApprovalDecision
  | "submit-client-config"
  | "submit-credential-input"
  | `userland:${string}`;

type ButtonVariant = "primary" | "surface" | "danger" | "dangerPrimary" | "outline";

const SECONDARY_GRANT_DECISIONS: Array<
  Exclude<ApprovalDecision, "once" | "version" | "repo" | "deny" | "dismiss">
> = ["session"];

export function ApprovalSheet({
  approvals,
  onResolve,
  onSubmitClientConfig,
  onSubmitCredentialInput,
  onResolveUserland,
  onNavigateToPanel,
}: ApprovalSheetProps) {
  const colors = useAtomValue(themeColorsAtom);
  const [browseIndex, setBrowseIndex] = useState(0);
  useEffect(() => {
    setBrowseIndex((idx) => {
      if (approvals.length === 0) return 0;
      if (idx >= approvals.length) return approvals.length - 1;
      return idx;
    });
  }, [approvals.length]);

  const current = approvals[browseIndex] ?? approvals[0] ?? null;
  const queueLength = approvals.length;
  const canPrev = queueLength > 1 && browseIndex > 0;
  const canNext = queueLength > 1 && browseIndex < queueLength - 1;
  const [values, setValues] = useState<Record<string, string>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const translateY = useRef(new Animated.Value(Dimensions.get("window").height)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const dragOffset = useRef(0);

  const callerInfo = current ? resolveCallerInfo(current) : null;
  const copy = current && callerInfo ? getApprovalCopy(current) : null;
  const attribution = current ? getApprovalAttribution(current) : null;
  const severeCapability = current?.kind === "capability" && current.severity === "severe";
  const accentColor = severeCapability
    ? colors.danger
    : current?.kind === "unit-batch"
      ? colors.warning
      : colors.primary;

  const isBusy = pendingAction !== null;
  const currentApprovalId = current?.approvalId;

  useEffect(() => {
    if (!current) return;
    setValues({});
    setError(null);
    setPendingAction(null);
    setDetailsOpen(
      shouldOpenApprovalDetails(current) ||
        (current.kind === "credential" && !!current.oauthAudienceDomainMismatch)
    );
    ReactNativeHapticFeedback.trigger("impactLight");
    Animated.parallel([
      Animated.spring(translateY, {
        toValue: 0,
        useNativeDriver: true,
        stiffness: 220,
        damping: 28,
        mass: 1,
      }),
      Animated.timing(backdropOpacity, {
        toValue: 1,
        duration: 200,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }),
    ]).start();
    if (copy) {
      const requester = callerInfo
        ? `Requested by ${callerInfo.label}, ${callerInfo.kindLabel.toLowerCase()}. `
        : "";
      AccessibilityInfo.announceForAccessibility(`${copy.title}. ${requester}${copy.summary}`);
    }
  }, [currentApprovalId]);

  const runAction = useCallback(
    async (action: PendingAction, task: () => Promise<void> | void) => {
      if (isBusy) return;
      setError(null);
      setPendingAction(action);
      if (action === "deny") {
        ReactNativeHapticFeedback.trigger("notificationWarning");
      } else {
        ReactNativeHapticFeedback.trigger("impactMedium");
      }
      try {
        await task();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Couldn't resolve. Try again.";
        setError(message || "Couldn't resolve. Try again.");
      } finally {
        setPendingAction(null);
      }
    },
    [isBusy]
  );

  const dismiss = useCallback(() => {
    if (!current || isBusy) return;
    const action: PendingAction = current.kind === "userland" ? "userland:dismiss" : "dismiss";
    void runAction(action, () => {
      if (current.kind === "userland") {
        return onResolveUserland(current.approvalId, "dismiss");
      }
      return onResolve(current.approvalId, "dismiss");
    });
  }, [current, isBusy, onResolve, onResolveUserland, runAction]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, gesture) =>
          !isBusy && gesture.dy > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_event, gesture) => {
          const next = Math.max(0, gesture.dy);
          dragOffset.current = next;
          translateY.setValue(next);
        },
        onPanResponderRelease: (_event, gesture) => {
          if (gesture.dy > 120 || gesture.vy > 0.8) {
            ReactNativeHapticFeedback.trigger("impactLight");
            dismiss();
            return;
          }
          dragOffset.current = 0;
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            stiffness: 220,
            damping: 28,
          }).start();
        },
      }),
    [dismiss, isBusy, translateY]
  );

  const showRequestingPanel = useCallback(() => {
    if (callerInfo?.panelId && onNavigateToPanel) {
      onNavigateToPanel(callerInfo.panelId);
    }
  }, [callerInfo, onNavigateToPanel]);

  if (!current || !copy || !callerInfo) return null;

  return (
    <Modal visible transparent animationType="none" presentationStyle="overFullScreen">
      <View style={styles.modalRoot}>
        <Animated.View style={[styles.backdrop, { opacity: backdropOpacity }]}>
          <Pressable
            accessibilityLabel="Dismiss approval"
            disabled={isBusy}
            onPress={dismiss}
            style={StyleSheet.absoluteFill}
            testID="approval-backdrop"
          />
        </Animated.View>
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : "height"}
          style={styles.keyboardRoot}
        >
          <SafeAreaView edges={["bottom"]} style={styles.safeArea}>
            <Animated.View
              accessibilityViewIsModal
              style={[
                styles.sheet,
                {
                  backgroundColor: colors.surface,
                  borderColor: colors.border,
                  transform: [{ translateY }],
                },
              ]}
              testID="approval-sheet"
            >
              <View
                style={[styles.accentStripe, { backgroundColor: accentColor }]}
                testID="approval-accent-stripe"
              />
              <Pressable
                accessibilityLabel="Dismiss approval"
                accessibilityRole="button"
                disabled={isBusy}
                onPress={dismiss}
                style={styles.dismissButton}
                testID="approval-dismiss"
              >
                <X size={20} color={colors.textSecondary} />
              </Pressable>
              <View style={styles.handleWrap} {...panResponder.panHandlers}>
                <View style={[styles.handle, { backgroundColor: colors.border }]} />
              </View>

              <ScrollView
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={styles.scrollContent}
              >
                <ApprovalHeader
                  approval={current}
                  accentColor={accentColor}
                  queueLength={queueLength}
                  queueIndex={browseIndex}
                  canPrev={canPrev}
                  canNext={canNext}
                  onPrev={() => setBrowseIndex((idx) => Math.max(0, idx - 1))}
                  onNext={() => setBrowseIndex((idx) => Math.min(queueLength - 1, idx + 1))}
                />
                <Text style={[styles.title, { color: colors.text }]}>{copy.title}</Text>
                <CallerRow
                  caller={callerInfo}
                  attribution={attribution ?? {}}
                  canNavigate={!!onNavigateToPanel && !!callerInfo.panelId}
                  onPress={showRequestingPanel}
                />
                {copy.warning ? <WarningBand message={copy.warning} /> : null}
                {current.kind === "device-code" ? <DeviceCodePanel approval={current} /> : null}
                {error ? <InlineError message={error} /> : null}
                {current.kind === "client-config" || current.kind === "credential-input" ? (
                  <SecretConfigFields
                    approval={current}
                    values={values}
                    onChange={(name, value) =>
                      setValues((previous) => ({ ...previous, [name]: value }))
                    }
                  />
                ) : null}
                <ApprovalDetails
                  approval={current}
                  caller={callerInfo}
                  open={detailsOpen}
                  onToggle={() => setDetailsOpen((open) => !open)}
                />
                {current.kind === "userland" ? (
                  <RememberedHint approval={current} caller={callerInfo} />
                ) : null}
              </ScrollView>

              <View
                style={[
                  styles.actionBar,
                  { borderTopColor: colors.border, backgroundColor: colors.surface },
                ]}
              >
                {current.kind === "client-config" ? (
                  <ClientConfigActions
                    approval={current}
                    values={values}
                    busy={isBusy}
                    pendingAction={pendingAction}
                    onSubmit={() =>
                      runAction("submit-client-config", () =>
                        onSubmitClientConfig(current.approvalId, values)
                      )
                    }
                    onDeny={() => runAction("deny", () => onResolve(current.approvalId, "deny"))}
                  />
                ) : current.kind === "credential-input" ? (
                  <CredentialInputActions
                    approval={current}
                    values={values}
                    busy={isBusy}
                    pendingAction={pendingAction}
                    onSubmit={() =>
                      runAction("submit-credential-input", () =>
                        onSubmitCredentialInput(current.approvalId, values)
                      )
                    }
                    onDeny={() => runAction("deny", () => onResolve(current.approvalId, "deny"))}
                  />
                ) : current.kind === "userland" ? (
                  <UserlandActions
                    approval={current}
                    busy={isBusy}
                    pendingAction={pendingAction}
                    onChoose={(choice) =>
                      runAction(`userland:${choice}`, () =>
                        onResolveUserland(current.approvalId, choice)
                      )
                    }
                  />
                ) : current.kind === "device-code" ? (
                  <DeviceCodeActions
                    busy={isBusy}
                    pendingAction={pendingAction}
                    onCancel={() =>
                      runAction("dismiss", () => onResolve(current.approvalId, "dismiss"))
                    }
                  />
                ) : current.kind === "unit-batch" ? (
                  <UnitBatchActions
                    approval={current}
                    busy={isBusy}
                    pendingAction={pendingAction}
                    onChoose={(decision) =>
                      runAction(decision, () => onResolve(current.approvalId, decision))
                    }
                  />
                ) : (
                  <StandardActions
                    approval={current}
                    busy={isBusy}
                    pendingAction={pendingAction}
                    onChoose={(decision) =>
                      runAction(decision, () => onResolve(current.approvalId, decision))
                    }
                  />
                )}
              </View>
            </Animated.View>
          </SafeAreaView>
        </KeyboardAvoidingView>
      </View>
    </Modal>
  );
}

function ApprovalHeader({
  approval,
  accentColor,
  queueLength,
  queueIndex,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  approval: PendingApproval;
  accentColor: string;
  queueLength: number;
  queueIndex: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const CategoryIcon = getCategoryIcon(approval);
  return (
    <View style={styles.headerRow}>
      <View
        style={[styles.categoryIcon, { backgroundColor: accentColor }]}
        testID="approval-category-icon"
      >
        <CategoryIcon size={17} color="#ffffff" />
      </View>
      {queueLength > 1 ? (
        <QueueNavigator
          index={queueIndex}
          total={queueLength}
          canPrev={canPrev}
          canNext={canNext}
          onPrev={onPrev}
          onNext={onNext}
        />
      ) : null}
    </View>
  );
}

function QueueNavigator({
  index,
  total,
  canPrev,
  canNext,
  onPrev,
  onNext,
}: {
  index: number;
  total: number;
  canPrev: boolean;
  canNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View style={styles.queueNavigator}>
      <Pressable
        accessibilityLabel="Previous approval"
        accessibilityRole="button"
        accessibilityState={{ disabled: !canPrev }}
        disabled={!canPrev}
        onPress={onPrev}
        style={[styles.queueButton, !canPrev ? styles.disabled : null]}
        testID="approval-queue-prev"
      >
        <ChevronLeft size={16} color={colors.textSecondary} />
      </Pressable>
      <Text style={[styles.queueLabel, { color: colors.textSecondary }]}>
        {index + 1} / {total}
      </Text>
      <Pressable
        accessibilityLabel="Next approval"
        accessibilityRole="button"
        accessibilityState={{ disabled: !canNext }}
        disabled={!canNext}
        onPress={onNext}
        style={[styles.queueButton, !canNext ? styles.disabled : null]}
        testID="approval-queue-next"
      >
        <ChevronRight size={16} color={colors.textSecondary} />
      </Pressable>
    </View>
  );
}

function CallerRow({
  caller,
  attribution,
  canNavigate,
  onPress,
}: {
  caller: CallerInfo;
  attribution: ApprovalAttribution;
  canNavigate: boolean;
  onPress: () => void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const KindIcon =
    caller.kind === "panel" ? LayoutPanelTop : caller.kind === "worker" ? Workflow : Settings2;
  const chip = (
    <View
      style={[
        styles.callerChip,
        { backgroundColor: colors.background, borderColor: colors.border },
      ]}
    >
      <KindIcon size={12} color={colors.textSecondary} />
      <Text numberOfLines={1} style={[styles.callerChipLabel, { color: colors.text }]}>
        {caller.label}
      </Text>
      {canNavigate ? <ArrowRight size={12} color={colors.accent} /> : null}
    </View>
  );
  return (
    <View style={styles.callerRow}>
      {canNavigate ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Show ${caller.kindLabel.toLowerCase()} ${caller.label}`}
          onPress={onPress}
          testID="approval-caller-chip"
          style={({ pressed }) => [pressed ? styles.pressed : null]}
        >
          {chip}
        </Pressable>
      ) : (
        <View testID="approval-caller-chip">{chip}</View>
      )}
      <Text style={[styles.callerRowLabel, { color: colors.textSecondary }]}>
        {caller.kindLabel.toLowerCase()}
      </Text>
      {attribution.target ? (
        <>
          <Text style={[styles.callerRowLabel, { color: colors.textSecondary }]}>
            {attribution.relation ?? "for"}
          </Text>
          <View
            style={[
              styles.callerChip,
              { backgroundColor: colors.background, borderColor: colors.border },
            ]}
          >
            <Text numberOfLines={1} style={[styles.callerChipLabel, { color: colors.text }]}>
              {attribution.target}
            </Text>
          </View>
        </>
      ) : null}
    </View>
  );
}

function getCategoryIcon(approval: PendingApproval): IconComponent {
  if (approval.kind === "capability") return ExternalLink;
  if (approval.kind === "client-config" || approval.kind === "credential-input") return Settings2;
  if (approval.kind === "userland")
    return approval.callerKind === "worker"
      ? Workflow
      : approval.callerKind === "panel"
        ? LayoutPanelTop
        : Settings2;
  if (approval.kind === "device-code") return ExternalLink;
  return Lock;
}

function WarningBand({ message }: { message: string }) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View
      accessibilityRole="alert"
      style={[
        styles.warningBand,
        { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
      ]}
    >
      <AlertTriangle size={14} color={colors.danger} />
      <Text style={[styles.warningText, { color: colors.danger }]}>{message}</Text>
    </View>
  );
}

function InlineError({ message }: { message: string }) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View
      style={[
        styles.warningBand,
        { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
      ]}
    >
      <AlertTriangle size={14} color={colors.danger} />
      <Text style={[styles.warningText, { color: colors.danger }]}>{message}</Text>
    </View>
  );
}

function SecretConfigFields({
  approval,
  values,
  onChange,
}: {
  approval: PendingClientConfigApproval | PendingCredentialInputApproval;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View style={styles.fields}>
      <Text style={[styles.helperText, { color: colors.textSecondary }]}>
        Secrets are entered in NatStack's shell UI, not exposed to panels or workers, and stored
        encrypted after submission.
      </Text>
      {approval.fields.map((field) => (
        <View key={field.name} style={styles.fieldBlock}>
          <View style={styles.fieldLabelRow}>
            <Text style={[styles.fieldLabel, { color: colors.text }]}>{field.label}</Text>
            {field.required ? <Pill tone="warning">Required</Pill> : null}
            {field.type === "secret" ? <Pill>Secret</Pill> : null}
          </View>
          <TextInput
            accessibilityLabel={field.label}
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(text) => onChange(field.name, text)}
            placeholder={field.label}
            placeholderTextColor={colors.textSecondary}
            secureTextEntry={field.type === "secret"}
            style={[
              styles.input,
              {
                backgroundColor: colors.background,
                borderColor: colors.border,
                color: colors.text,
              },
            ]}
            testID={`approval-field-${field.name}`}
            value={values[field.name] ?? ""}
          />
          {field.description ? (
            <Text style={[styles.helperText, { color: colors.textSecondary }]}>
              {field.description}
            </Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function ApprovalDetails({
  approval,
  caller,
  open,
  onToggle,
}: {
  approval: PendingApproval;
  caller: CallerInfo;
  open: boolean;
  onToggle: () => void;
}) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View style={styles.detailsBlock}>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={onToggle}
        style={styles.detailsSummary}
      >
        <ChevronDown
          size={14}
          color={colors.textSecondary}
          // Visual hint: chevron points down when open, right when closed.
          // Native RN can't rotate icons declaratively without animated value;
          // we keep it static and rely on accessibilityState for assistive tech.
        />
        <Text style={[styles.detailsSummaryText, { color: colors.textSecondary }]}>
          Request details
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.detailRows}>
          <DetailRow
            icon={User}
            label="Requester"
            value={`${caller.kindLabel} · ${caller.label}`}
            secondary={approval.callerId}
            secondarySelectable
          />
          <DetailRow icon={Globe} label="Repo" value={approval.repoPath} code />
          <DetailRow icon={Lock} label="Version" value={approval.effectiveVersion} code />
          {approval.kind === "credential" ? (
            <CredentialDetails approval={approval} />
          ) : approval.kind === "client-config" ? (
            <ClientConfigDetails approval={approval} />
          ) : approval.kind === "credential-input" ? (
            <CredentialInputDetails approval={approval} />
          ) : approval.kind === "userland" ? (
            <UserlandDetails approval={approval} />
          ) : approval.kind === "device-code" ? (
            <DeviceCodeDetails approval={approval} />
          ) : approval.kind === "unit-batch" ? (
            <UnitBatchDetails approval={approval} />
          ) : (
            <CapabilityDetails approval={approval} />
          )}
        </View>
      ) : null}
    </View>
  );
}

function CredentialDetails({ approval }: { approval: PendingCredentialApproval }) {
  const oauthOrigins = [
    approval.oauthAuthorizeOrigin,
    approval.oauthTokenOrigin,
    approval.oauthUserinfoOrigin,
  ].filter((origin): origin is string => !!origin);
  return (
    <>
      <DetailRow icon={Lock} label="Account" value={formatAccount(approval)} code />
      <DetailRow icon={Lock} label="Injects as" value={formatInjection(approval)} code />
      {approval.gitOperation ? (
        <>
          <DetailRow icon={Lock} label="Operation" value={approval.gitOperation.label} code />
          <DetailRow icon={Globe} label="Remote" value={approval.gitOperation.remote} code />
        </>
      ) : null}
      <DetailRow
        icon={Globe}
        label="Audience"
        value={approval.audience.map((audience) => `${audience.match}: ${audience.url}`).join("\n")}
        code
      />
      {oauthOrigins.length > 0 ? (
        <DetailRow
          icon={Globe}
          label="OAuth"
          value={oauthOrigins.join("\n")}
          danger={!!approval.oauthAudienceDomainMismatch}
          code
        />
      ) : null}
      {approval.oauthAudienceDomainMismatch ? (
        <DetailRow
          icon={AlertTriangle}
          label="Warning"
          value="OAuth domain differs from audience"
          danger
        />
      ) : null}
      {approval.scopes.length > 0 ? (
        <DetailRow icon={Lock} label="Scopes" value={approval.scopes.join(", ")} code />
      ) : null}
    </>
  );
}

function ClientConfigDetails({ approval }: { approval: PendingClientConfigApproval }) {
  const tokenOrigin = originForUrl(approval.tokenUrl);
  const authorizeOrigin = originForUrl(approval.authorizeUrl);
  return (
    <>
      <DetailRow icon={Lock} label="Client" value={approval.configId} code />
      <DetailRow icon={Globe} label="Authorize" value={approval.authorizeUrl} code />
      <DetailRow icon={Globe} label="Token URL" value={approval.tokenUrl} code />
      <DetailRow
        icon={Lock}
        label="Binding"
        value={`Secret use limited to ${tokenOrigin}${authorizeOrigin !== tokenOrigin ? `\nSign-in starts at ${authorizeOrigin}` : ""}`}
      />
      <DetailRow
        icon={Lock}
        label="Fields"
        value={approval.fields
          .map((field) => `${field.name}${field.type === "secret" ? " (secret)" : ""}`)
          .join(", ")}
        code
      />
    </>
  );
}

function CredentialInputDetails({ approval }: { approval: PendingCredentialInputApproval }) {
  return (
    <>
      <DetailRow icon={Lock} label="Service" value={approval.credentialLabel} code />
      <DetailRow icon={Lock} label="Injects as" value={formatInjection(approval)} code />
      <DetailRow
        icon={Globe}
        label="Audience"
        value={formatCredentialInputAudienceSummary(approval)}
        code
      />
      <DetailRow
        icon={Lock}
        label="Fields"
        value={approval.fields
          .map((field) => `${field.name}${field.type === "secret" ? " (secret)" : ""}`)
          .join(", ")}
        code
      />
      {approval.scopes.length > 0 ? (
        <DetailRow icon={Lock} label="Scopes" value={approval.scopes.join(", ")} code />
      ) : null}
    </>
  );
}

function CapabilityDetails({ approval }: { approval: PendingCapabilityApproval }) {
  return (
    <>
      {approval.resource ? (
        <DetailRow
          icon={Globe}
          label={approval.resource.label}
          value={approval.resource.value}
          code
        />
      ) : null}
      {(approval.details ?? []).map((detail) => (
        <DetailRow key={detail.label} icon={Lock} label={detail.label} value={detail.value} code />
      ))}
    </>
  );
}

function UserlandDetails({ approval }: { approval: PendingUserlandApproval }) {
  const issuer = approval.issuer;
  const showIssuer =
    issuer && (issuer.kind !== approval.callerKind || issuer.id !== approval.callerId);
  return (
    <>
      {showIssuer && issuer ? (
        <DetailRow
          icon={User}
          label="Asked by"
          value={`${issuer.kind} · ${issuer.label ?? prettifyId(issuer.id)}`}
          code
        />
      ) : null}
      <DetailRow icon={Lock} label="Subject" value={approval.subject.id} code />
      {approval.subject.label ? (
        <DetailRow icon={Lock} label="Label" value={approval.subject.label} code />
      ) : null}
      {(approval.details ?? []).map((detail) => (
        <DetailRow key={detail.label} icon={Lock} label={detail.label} value={detail.value} code />
      ))}
    </>
  );
}

function DeviceCodeDetails({ approval }: { approval: PendingDeviceCodeApproval }) {
  return (
    <>
      <DetailRow icon={Lock} label="Service" value={approval.credentialLabel} code />
      <DetailRow icon={Globe} label="Verify at" value={approval.verificationUri} code />
      <DetailRow
        icon={Lock}
        label="Provider"
        value={originForUrl(approval.oauthTokenOrigin)}
        code
      />
    </>
  );
}

function UnitBatchDetails({ approval }: { approval: PendingUnitBatchApproval }) {
  return (
    <>
      {approval.configWrite ? (
        <DetailRow
          icon={Settings2}
          label="Workspace config"
          value={`${approval.configWrite.repoPath} · ${approval.configWrite.summary}`}
          code
        />
      ) : null}
      {approval.units.map((entry) => (
        <React.Fragment key={`${entry.unitKind}:${entry.unitName}`}>
          <DetailRow
            icon={Lock}
            label={entry.unitKind === "app" ? "App" : "Extension"}
            value={entry.unitName}
            code
          />
          <DetailRow
            icon={Globe}
            label="Source"
            value={`${entry.source.repo}@${entry.source.ref}`}
            code
          />
          {entry.target ? (
            <DetailRow icon={Settings2} label="Target" value={entry.target} code />
          ) : null}
          {entry.version ? (
            <DetailRow icon={Lock} label="Version" value={entry.version} code />
          ) : null}
          {entry.ev ? <DetailRow icon={Lock} label="EV" value={entry.ev} code /> : null}
          {entry.integrity ? (
            <DetailRow icon={Lock} label="Integrity" value={entry.integrity} code />
          ) : null}
          {entry.provider ? (
            <DetailRow
              icon={Settings2}
              label="Provider"
              value={`${entry.provider.name}@${entry.provider.activeEv ?? "unknown"}`}
              code
            />
          ) : null}
          {entry.capabilities.length > 0 ? (
            <DetailRow icon={Lock} label="Access" value={entry.capabilities.join(", ")} code />
          ) : null}
        </React.Fragment>
      ))}
    </>
  );
}

function DeviceCodePanel({ approval }: { approval: PendingDeviceCodeApproval }) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View
      style={[
        styles.issuerPanel,
        { backgroundColor: colors.background, borderColor: colors.border },
      ]}
    >
      <Text style={[styles.helperText, { color: colors.textSecondary }]}>Enter this code:</Text>
      <Text
        accessibilityLabel={`Device code ${approval.userCode}`}
        selectable
        style={[styles.deviceCode, { color: colors.text, backgroundColor: colors.codeBackground }]}
      >
        {approval.userCode}
      </Text>
      <Text style={[styles.helperText, { color: colors.textSecondary }]}>
        at{" "}
        <Text style={[styles.codeText, { color: colors.text }]}>
          {originForUrl(approval.verificationUri)}
        </Text>
      </Text>
      <Text style={[styles.helperText, { color: colors.textSecondary }]}>
        The browser was opened to the verification page. The connection will complete automatically
        once you approve there.
      </Text>
    </View>
  );
}

function DeviceCodeActions({
  busy,
  pendingAction,
  onCancel,
}: {
  busy: boolean;
  pendingAction: PendingAction | null;
  onCancel: () => void;
}) {
  return (
    <View style={styles.actionRow}>
      <DecisionButton
        label="Cancel"
        description="Stop waiting for the device sign-in."
        variant="outline"
        disabled={busy}
        loading={pendingAction === "dismiss"}
        icon={XCircle}
        onPress={onCancel}
        testID="approval-action-device-cancel"
      />
    </View>
  );
}

function DetailRow({
  icon: RowIcon,
  label,
  value,
  code,
  danger,
  secondary,
  secondarySelectable,
}: {
  icon: IconComponent;
  label: string;
  value: string;
  code?: boolean;
  danger?: boolean;
  /** Optional supplementary value (e.g. the full opaque id under a label). */
  secondary?: string;
  secondarySelectable?: boolean;
}) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View accessibilityLabel={`${label}: ${value}`} style={styles.detailRow}>
      <RowIcon size={14} color={danger ? colors.danger : colors.textSecondary} />
      <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>{label}</Text>
      <View style={styles.detailValueColumn}>
        <Text
          style={[
            styles.detailValue,
            code ? styles.codeText : null,
            {
              color: danger ? colors.danger : colors.text,
              backgroundColor: code ? colors.codeBackground : "transparent",
            },
          ]}
        >
          {value}
        </Text>
        {secondary ? (
          <Text
            selectable={secondarySelectable}
            style={[
              styles.detailValueSecondary,
              styles.codeText,
              { color: colors.textSecondary, backgroundColor: colors.codeBackground },
            ]}
          >
            {secondary}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function StandardActions({
  approval,
  busy,
  pendingAction,
  onChoose,
}: {
  approval: PendingCredentialApproval | PendingCapabilityApproval;
  busy: boolean;
  pendingAction: PendingAction | null;
  onChoose: (decision: ApprovalDecision) => void;
}) {
  const copy = getStandardActionCopy(approval);
  const severePanelCapability =
    approval.kind === "capability" &&
    approval.severity === "severe" &&
    (approval.capability === "panel.automate" || approval.capability === "panel.structural");
  return (
    <View style={styles.actionGroups}>
      <View style={styles.actionRow}>
        <DecisionButton
          label={copy.once.label}
          description={copy.once.description}
          variant="surface"
          disabled={busy}
          loading={pendingAction === "once"}
          onPress={() => onChoose("once")}
          testID="approval-action-once"
        />
        <DecisionButton
          label={copy.version.label}
          description={copy.version.description}
          variant={severePanelCapability ? "dangerPrimary" : "primary"}
          disabled={busy}
          loading={pendingAction === "version"}
          icon={severePanelCapability ? AlertTriangle : CheckCircle2}
          onPress={() => onChoose("version")}
          testID="approval-action-version"
        />
        <DecisionButton
          label="Deny"
          description={copy.denyDescription}
          variant="danger"
          disabled={busy}
          loading={pendingAction === "deny"}
          icon={XCircle}
          onPress={() => onChoose("deny")}
          testID="approval-action-deny"
        />
      </View>
      <View style={styles.actionRow}>
        {SECONDARY_GRANT_DECISIONS.map((decision) => (
          <DecisionButton
            key={decision}
            label={copy[decision].label}
            description={copy[decision].description}
            variant="outline"
            disabled={busy}
            loading={pendingAction === decision}
            onPress={() => onChoose(decision)}
            testID={`approval-action-${decision}`}
          />
        ))}
      </View>
    </View>
  );
}

function UnitBatchActions({
  approval,
  busy,
  pendingAction,
  onChoose,
}: {
  approval: PendingUnitBatchApproval;
  busy: boolean;
  pendingAction: PendingAction | null;
  onChoose: (decision: ApprovalDecision) => void;
}) {
  const copy = getUnitBatchActionCopy(approval);
  return (
    <View style={styles.actionGroups}>
      <View style={styles.actionRow}>
        <DecisionButton
          label={copy.once.label}
          description={copy.once.description}
          variant="primary"
          disabled={busy}
          loading={pendingAction === "once"}
          onPress={() => onChoose("once")}
          testID="approval-action-once"
        />
        {copy.session ? (
          <DecisionButton
            label={copy.session.label}
            description={copy.session.description}
            variant="surface"
            disabled={busy}
            loading={pendingAction === "session"}
            onPress={() => onChoose("session")}
            testID="approval-action-session"
          />
        ) : null}
        <DecisionButton
          label={copy.deny.label}
          description={copy.deny.description}
          variant="danger"
          disabled={busy}
          loading={pendingAction === "deny"}
          icon={XCircle}
          onPress={() => onChoose("deny")}
          testID="approval-action-deny"
        />
      </View>
    </View>
  );
}

function ClientConfigActions(props: {
  approval: PendingClientConfigApproval;
  values: Record<string, string>;
  busy: boolean;
  pendingAction: PendingAction | null;
  onSubmit: () => void;
  onDeny: () => void;
}) {
  return <InputApprovalActions {...props} submitAction="submit-client-config" />;
}

function CredentialInputActions(props: {
  approval: PendingCredentialInputApproval;
  values: Record<string, string>;
  busy: boolean;
  pendingAction: PendingAction | null;
  onSubmit: () => void;
  onDeny: () => void;
}) {
  return <InputApprovalActions {...props} submitAction="submit-credential-input" />;
}

function InputApprovalActions({
  approval,
  values,
  busy,
  pendingAction,
  onSubmit,
  onDeny,
  submitAction,
}: {
  approval: PendingClientConfigApproval | PendingCredentialInputApproval;
  values: Record<string, string>;
  busy: boolean;
  pendingAction: PendingAction | null;
  onSubmit: () => void;
  onDeny: () => void;
  submitAction: PendingAction;
}) {
  const missingRequired = approval.fields.some(
    (field) => field.required && !values[field.name]?.trim()
  );
  return (
    <View style={styles.actionRow}>
      <DecisionButton
        label="Save service"
        description="Save this connected service."
        variant="primary"
        disabled={busy || missingRequired}
        loading={pendingAction === submitAction}
        onPress={onSubmit}
        testID="approval-submit"
      />
      <DecisionButton
        label="Deny"
        description="Do not save this connected service."
        variant="danger"
        disabled={busy}
        loading={pendingAction === "deny"}
        icon={XCircle}
        onPress={onDeny}
        testID="approval-action-deny"
      />
    </View>
  );
}

function UserlandActions({
  approval,
  busy,
  pendingAction,
  onChoose,
}: {
  approval: PendingUserlandApproval;
  busy: boolean;
  pendingAction: PendingAction | null;
  onChoose: (choice: string) => void;
}) {
  return (
    <View style={styles.userlandActionWrap}>
      {approval.options.map((option) => (
        <UserlandButton
          key={option.value}
          option={option}
          disabled={busy}
          loading={pendingAction === `userland:${option.value}`}
          onPress={() => onChoose(option.value)}
        />
      ))}
    </View>
  );
}

function UserlandButton({
  option,
  disabled,
  loading,
  onPress,
}: {
  option: UserlandApprovalOption;
  disabled: boolean;
  loading: boolean;
  onPress: () => void;
}) {
  const variant: ButtonVariant =
    option.tone === "primary" ? "primary" : option.tone === "danger" ? "danger" : "surface";
  return (
    <DecisionButton
      label={option.label}
      description={option.description ?? option.label}
      variant={variant}
      disabled={disabled}
      loading={loading}
      icon={option.tone === "danger" ? XCircle : CheckCircle2}
      onPress={onPress}
      testID={`approval-userland-${option.value}`}
    />
  );
}

function DecisionButton({
  label,
  description,
  variant,
  disabled,
  loading,
  icon: ButtonIcon = CheckCircle2,
  onPress,
  testID,
}: {
  label: string;
  description: string;
  variant: ButtonVariant;
  disabled: boolean;
  loading: boolean;
  icon?: IconComponent;
  onPress: () => void;
  testID: string;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const style = buttonStyle(colors, variant);
  return (
    <Pressable
      accessibilityLabel={`${label}. ${description}`}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.decisionButton,
        style.button,
        disabled ? styles.disabled : null,
        pressed && !disabled ? styles.pressed : null,
      ]}
      testID={testID}
    >
      {loading ? (
        <ActivityIndicator color={style.text.color} size="small" />
      ) : (
        <ButtonIcon size={16} color={style.text.color} />
      )}
      <Text numberOfLines={2} adjustsFontSizeToFit style={[styles.decisionText, style.text]}>
        {label}
      </Text>
    </Pressable>
  );
}

function buttonStyle(
  colors: {
    background: string;
    border: string;
    danger: string;
    primary: string;
    text: string;
  },
  variant: ButtonVariant
) {
  if (variant === "primary") {
    return {
      button: { backgroundColor: colors.primary, borderColor: colors.primary },
      text: { color: "#ffffff" },
    };
  }
  if (variant === "danger") {
    return {
      button: { backgroundColor: "transparent", borderColor: colors.danger },
      text: { color: colors.danger },
    };
  }
  if (variant === "dangerPrimary") {
    return {
      button: { backgroundColor: colors.danger, borderColor: colors.danger },
      text: { color: "#ffffff" },
    };
  }
  if (variant === "outline") {
    return {
      button: { backgroundColor: "transparent", borderColor: colors.border },
      text: { color: colors.text },
    };
  }
  return {
    button: { backgroundColor: colors.background, borderColor: colors.border },
    text: { color: colors.text },
  };
}

function Pill({ children, tone }: { children: React.ReactNode; tone?: "warning" }) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <Text
      style={[
        styles.pill,
        {
          color: tone === "warning" ? colors.warning : colors.textSecondary,
          borderColor: tone === "warning" ? colors.warning : colors.border,
          backgroundColor: colors.background,
        },
      ]}
    >
      {children}
    </Text>
  );
}

function RememberedHint({
  approval,
  caller,
}: {
  approval: PendingUserlandApproval;
  caller: CallerInfo;
}) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View style={styles.rememberedHint}>
      <Info size={14} color={colors.textSecondary} />
      <Text style={[styles.helperText, { color: colors.textSecondary }]}>
        {approval.promptOptions === "scoped"
          ? "Use Trust version to remember this approval."
          : `Remembered for ${caller.kindLabel.toLowerCase()} "${caller.label}" until revoked.`}
      </Text>
    </View>
  );
}

function truncateId(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}...${id.slice(-tail)}`;
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.5)",
  },
  keyboardRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  safeArea: {
    justifyContent: "flex-end",
  },
  sheet: {
    alignSelf: "stretch",
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    maxHeight: Dimensions.get("window").height * 0.9,
    minHeight: Dimensions.get("window").height * 0.4,
    overflow: "hidden",
  },
  accentStripe: {
    height: 3,
  },
  dismissButton: {
    alignItems: "center",
    height: 44,
    justifyContent: "center",
    position: "absolute",
    right: 6,
    top: 8,
    width: 44,
    zIndex: 2,
  },
  handleWrap: {
    alignItems: "center",
    paddingBottom: 10,
    paddingTop: 8,
  },
  handle: {
    borderRadius: 2,
    height: 4,
    width: 36,
  },
  scrollContent: {
    paddingBottom: 18,
    paddingHorizontal: 18,
  },
  headerRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    paddingRight: 42,
  },
  categoryIcon: {
    alignItems: "center",
    borderRadius: 8,
    height: 32,
    justifyContent: "center",
    width: 32,
  },
  queueNavigator: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    marginLeft: "auto",
  },
  queueButton: {
    alignItems: "center",
    borderRadius: 6,
    height: 28,
    justifyContent: "center",
    width: 28,
  },
  queueLabel: {
    fontSize: 12,
    fontVariant: ["tabular-nums"],
    fontWeight: "600",
    minWidth: 36,
    textAlign: "center",
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    marginTop: 16,
  },
  callerRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 6,
    marginTop: 8,
  },
  callerRowLabel: {
    fontSize: 12,
    fontWeight: "500",
  },
  callerChip: {
    alignItems: "center",
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 5,
    maxWidth: 220,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  callerChipLabel: {
    flexShrink: 1,
    fontSize: 12,
    fontWeight: "600",
  },
  warningBand: {
    alignItems: "flex-start",
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: "row",
    gap: 8,
    marginTop: 12,
    padding: 10,
  },
  warningText: {
    flex: 1,
    fontSize: 13,
    fontWeight: "500",
    lineHeight: 18,
  },
  issuerPanel: {
    borderRadius: 8,
    borderWidth: 1,
    marginTop: 14,
    padding: 12,
  },
  helperText: {
    fontSize: 12,
    fontWeight: "400",
    lineHeight: 18,
  },
  fields: {
    gap: 12,
    marginTop: 14,
  },
  fieldBlock: {
    gap: 6,
  },
  fieldLabelRow: {
    alignItems: "center",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  fieldLabel: {
    fontSize: 13,
    fontWeight: "500",
  },
  input: {
    borderRadius: 10,
    borderWidth: 1,
    fontSize: 15,
    minHeight: Platform.OS === "ios" ? 44 : 48,
    paddingHorizontal: 12,
  },
  detailsBlock: {
    marginTop: 14,
  },
  detailsSummary: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    minHeight: 34,
  },
  detailsSummaryText: {
    fontSize: 13,
    fontWeight: "600",
  },
  detailRows: {
    gap: 9,
    paddingTop: 6,
  },
  detailRow: {
    alignItems: "flex-start",
    flexDirection: "row",
    gap: 8,
  },
  detailLabel: {
    flexShrink: 0,
    fontSize: 12,
    fontWeight: "500",
    width: 80,
  },
  detailValueColumn: {
    flex: 1,
    flexDirection: "column",
    gap: 4,
    minWidth: 0,
  },
  detailValue: {
    borderRadius: 6,
    flexWrap: "wrap",
    fontSize: 13,
    fontWeight: "500",
    lineHeight: 18,
    minWidth: 0,
  },
  detailValueSecondary: {
    alignSelf: "flex-start",
    borderRadius: 6,
    fontSize: 11,
    lineHeight: 16,
  },
  codeText: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  deviceCode: {
    fontFamily: Platform.select({ ios: "Menlo", android: "monospace", default: "monospace" }),
    fontSize: 28,
    fontWeight: "700",
    letterSpacing: 4,
    paddingHorizontal: 14,
    paddingVertical: 10,
    marginVertical: 8,
    alignSelf: "flex-start",
    borderRadius: 6,
  },
  actionBar: {
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingBottom: 14,
    paddingHorizontal: 14,
    paddingTop: 12,
  },
  actionGroups: {
    gap: 8,
  },
  actionRow: {
    flexDirection: "row",
    gap: 8,
  },
  userlandActionWrap: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  decisionButton: {
    alignItems: "center",
    borderRadius: 10,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    minHeight: Platform.OS === "ios" ? 44 : 48,
    minWidth: 96,
    paddingHorizontal: 10,
  },
  decisionText: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: "600",
    letterSpacing: 0,
    textAlign: "center",
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    transform: [{ scale: 0.96 }],
  },
  pill: {
    borderRadius: 999,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 11,
    fontWeight: "600",
    overflow: "hidden",
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  rememberedHint: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
    marginTop: 10,
  },
});
