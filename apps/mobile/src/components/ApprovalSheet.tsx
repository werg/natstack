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
  PendingExtensionApproval,
  PendingUserlandApproval,
  UserlandApprovalOption,
} from "@natstack/shared/approvals";
import {
  formatAccount,
  formatCredentialInputAudienceSummary,
  formatInjection,
  getApprovalCategoryLabel,
  getApprovalCopy,
  getStandardActionCopy,
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
const CheckCircle2 = icon("CheckCircle2", "+");
const ChevronDown = icon("ChevronDown", "v");
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
}

type PendingAction =
  | ApprovalDecision
  | "submit-client-config"
  | "submit-credential-input"
  | `userland:${string}`;

type ButtonVariant = "primary" | "surface" | "danger" | "outline";

const SECONDARY_GRANT_DECISIONS: Array<Exclude<ApprovalDecision, "once" | "version" | "repo" | "deny" | "dismiss">> = [
  "session",
];

export function ApprovalSheet({
  approvals,
  onResolve,
  onSubmitClientConfig,
  onSubmitCredentialInput,
  onResolveUserland,
}: ApprovalSheetProps) {
  const colors = useAtomValue(themeColorsAtom);
  const current = approvals[0] ?? null;
  const extraCount = Math.max(0, approvals.length - 1);
  const [values, setValues] = useState<Record<string, string>>({});
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const translateY = useRef(new Animated.Value(Dimensions.get("window").height)).current;
  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const dragOffset = useRef(0);

  const callerLabel = current?.callerKind === "worker" ? "Worker" : "Panel";
  const copy = current ? getApprovalCopy(current, callerLabel) : null;
  const categoryLabel = current ? getApprovalCategoryLabel(current) : "";

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
      AccessibilityInfo.announceForAccessibility(
        `${categoryLabel}. ${copy.title}. ${copy.summary}`
      );
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

  if (!current || !copy) return null;

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
              <View style={[styles.accentStripe, { backgroundColor: colors.primary }]} />
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
                  categoryLabel={categoryLabel}
                  extraCount={extraCount}
                />
                <Text style={[styles.title, { color: colors.text }]}>{copy.title}</Text>
                <Text style={[styles.summary, { color: colors.textSecondary }]}>
                  {copy.summary}
                </Text>
                {copy.warning ? <WarningBand message={copy.warning} /> : null}
                {current.kind === "userland" ? <IssuerPanel approval={current} /> : null}
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
                  callerLabel={callerLabel}
                  open={detailsOpen}
                  onToggle={() => setDetailsOpen((open) => !open)}
                />
                {current.kind === "userland" ? <RememberedHint issuer={current.callerId} /> : null}
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
                ) : current.kind === "extension" ? (
                  <StandardActions
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
  categoryLabel,
  extraCount,
}: {
  approval: PendingApproval;
  categoryLabel: string;
  extraCount: number;
}) {
  const colors = useAtomValue(themeColorsAtom);
  const CategoryIcon = getCategoryIcon(approval);
  return (
    <View style={styles.headerRow}>
      <View style={[styles.categoryIcon, { backgroundColor: colors.primary }]}>
        <CategoryIcon size={17} color="#ffffff" />
      </View>
      <Text style={[styles.categoryLabel, { color: colors.accent }]}>{categoryLabel}</Text>
      {approval.kind === "credential" ? <Pill>{approval.credentialLabel}</Pill> : null}
      {extraCount > 0 ? <Pill>+{extraCount} queued</Pill> : null}
    </View>
  );
}

function getCategoryIcon(approval: PendingApproval): IconComponent {
  if (approval.kind === "capability") return ExternalLink;
  if (approval.kind === "client-config" || approval.kind === "credential-input") return Settings2;
  if (approval.kind === "userland")
    return approval.callerKind === "worker" ? Workflow : LayoutPanelTop;
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

function IssuerPanel({ approval }: { approval: PendingUserlandApproval }) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View
      style={[
        styles.issuerPanel,
        { backgroundColor: colors.background, borderColor: colors.border },
      ]}
    >
      <View style={styles.issuerHeader}>
        <User size={14} color={colors.textSecondary} />
        <Text style={[styles.helperText, { color: colors.textSecondary }]}>
          From <IdCode value={approval.callerId} />:
        </Text>
      </View>
      <Text style={[styles.providerTitle, { color: colors.text }]}>{approval.title}</Text>
      <Text style={[styles.helperText, { color: colors.textSecondary }]}>
        Subject: <IdCode value={approval.subject.id} />
        {approval.subject.label ? ` ${approval.subject.label}` : ""}
      </Text>
      {approval.warning ? <WarningBand message={approval.warning} /> : null}
      {approval.summary ? (
        <Text style={[styles.providerSummary, { color: colors.text }]}>{approval.summary}</Text>
      ) : null}
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
  callerLabel,
  open,
  onToggle,
}: {
  approval: PendingApproval;
  callerLabel: string;
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
        <ChevronDown size={14} color={colors.textSecondary} />
        <Text style={[styles.detailsSummaryText, { color: colors.textSecondary }]}>
          Request details
        </Text>
      </Pressable>
      {open ? (
        <View style={styles.detailRows}>
          <DetailRow icon={User} label="Requester" value={`${callerLabel} ${approval.callerId}`} />
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
          ) : approval.kind === "extension" ? (
            <ExtensionDetails approval={approval} />
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
  return (
    <>
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

function ExtensionDetails({ approval }: { approval: PendingExtensionApproval }) {
  const diff = approval.extensionDiff?.stat;
  return (
    <>
      <DetailRow icon={Lock} label="Extension" value={approval.extensionName} code />
      <DetailRow icon={Lock} label="Action" value={approval.action} code />
      <DetailRow
        icon={Globe}
        label="Source"
        value={`${approval.source.repo}@${approval.source.ref}`}
        code
      />
      {approval.version ? (
        <DetailRow icon={Lock} label="Version" value={approval.version} code />
      ) : null}
      {approval.sha ? <DetailRow icon={Lock} label="SHA" value={approval.sha} code /> : null}
      {diff ? (
        <DetailRow
          icon={Lock}
          label="Diff"
          value={`${diff.filesChanged} files, +${diff.insertions} -${diff.deletions}`}
          code
        />
      ) : null}
      {approval.capabilities.length > 0 ? (
        <DetailRow icon={Lock} label="Capabilities" value={approval.capabilities.join(", ")} code />
      ) : null}
      {(approval.details ?? []).map((detail) => (
        <DetailRow key={detail.label} icon={Lock} label={detail.label} value={detail.value} code />
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
}: {
  icon: IconComponent;
  label: string;
  value: string;
  code?: boolean;
  danger?: boolean;
}) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View accessibilityLabel={`${label}: ${value}`} style={styles.detailRow}>
      <RowIcon size={14} color={danger ? colors.danger : colors.textSecondary} />
      <Text style={[styles.detailLabel, { color: colors.textSecondary }]}>{label}</Text>
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
    </View>
  );
}

function StandardActions({
  approval,
  busy,
  pendingAction,
  onChoose,
}: {
  approval: PendingCredentialApproval | PendingCapabilityApproval | PendingExtensionApproval;
  busy: boolean;
  pendingAction: PendingAction | null;
  onChoose: (decision: ApprovalDecision) => void;
}) {
  const copy = getStandardActionCopy(approval);
  if (approval.kind === "extension") {
    return (
      <View style={styles.actionGroups}>
        <View style={styles.actionRow}>
          <DecisionButton label={copy.once.label} description={copy.once.description} variant="primary" disabled={busy} loading={pendingAction === "once"} onPress={() => onChoose("once")} testID="approval-action-once" />
          <DecisionButton label="Deny" description={copy.denyDescription} variant="danger" disabled={busy} loading={pendingAction === "deny"} icon={XCircle} onPress={() => onChoose("deny")} testID="approval-action-deny" />
        </View>
      </View>
    );
  }
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
          variant="primary"
          disabled={busy}
          loading={pendingAction === "version"}
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

function RememberedHint({ issuer }: { issuer: string }) {
  const colors = useAtomValue(themeColorsAtom);
  return (
    <View style={styles.rememberedHint}>
      <Info size={14} color={colors.textSecondary} />
      <Text style={[styles.helperText, { color: colors.textSecondary }]}>
        Remembered for <IdCode value={issuer} /> until revoked.
      </Text>
    </View>
  );
}

function truncateId(id: string, head = 8, tail = 4): string {
  if (id.length <= head + tail + 1) return id;
  return `${id.slice(0, head)}...${id.slice(-tail)}`;
}

function IdCode({ value }: { value: string }) {
  return <Text>{truncateId(value)}</Text>;
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
  categoryLabel: {
    fontSize: 11,
    fontWeight: "700",
    letterSpacing: 0,
    textTransform: "uppercase",
  },
  title: {
    fontSize: 22,
    fontWeight: "600",
    marginTop: 16,
  },
  summary: {
    fontSize: 15,
    fontWeight: "400",
    lineHeight: 22,
    marginTop: 8,
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
  issuerHeader: {
    alignItems: "center",
    flexDirection: "row",
    gap: 6,
  },
  providerTitle: {
    fontSize: 16,
    fontWeight: "600",
    lineHeight: 22,
    marginTop: 10,
  },
  providerSummary: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 8,
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
  detailValue: {
    borderRadius: 6,
    flex: 1,
    flexWrap: "wrap",
    fontSize: 13,
    fontWeight: "500",
    lineHeight: 18,
    minWidth: 0,
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
