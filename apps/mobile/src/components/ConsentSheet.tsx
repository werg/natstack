import React from "react";
import {
  Modal,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from "react-native";
import { useAtomValue } from "jotai";
import { themeColorsAtom } from "../state/themeAtoms";

interface ConsentSheetProps {
  visible: boolean;
  providerId: string;
  providerName: string;
  scopes: string[];
  scopeDescriptions?: Record<string, string>;
  endpoints?: { url: string; methods: string[] | "*" }[];
  accounts?: { connectionId: string; label: string; email?: string }[];
  onApprove: (connectionId?: string) => void;
  onDeny: () => void;
}

export default function ConsentSheet({
  visible,
  providerId,
  providerName,
  scopes,
  scopeDescriptions,
  endpoints,
  accounts,
  onApprove,
  onDeny,
}: ConsentSheetProps) {
  const colors = useAtomValue(themeColorsAtom);
  const [selectedConnectionId, setSelectedConnectionId] = React.useState<string | undefined>(
    accounts?.[0]?.connectionId,
  );

  React.useEffect(() => {
    setSelectedConnectionId(accounts?.[0]?.connectionId);
  }, [accounts, visible]);

  const hasMultipleAccounts = (accounts?.length ?? 0) > 1;
  const selectedAccount =
    accounts?.find((account) => account.connectionId === selectedConnectionId) ?? accounts?.[0];

  const handleApprove = () => {
    onApprove(selectedAccount?.connectionId);
  };

  const providerDescription = `${providerName} is requesting permission to access your connected account using the scopes and endpoints listed below.`;

  return (
    <Modal
      animationType="slide"
      transparent
      visible={visible}
      onRequestClose={onDeny}
    >
      <View style={styles.modalRoot}>
        <TouchableOpacity style={styles.backdrop} activeOpacity={1} onPress={onDeny} />

        <View
          style={[
            styles.sheet,
            {
              backgroundColor: colors.surface,
              borderColor: colors.border,
            },
          ]}
        >
          <View style={[styles.handle, { backgroundColor: colors.border }]} />

          <ScrollView
            style={styles.scrollView}
            contentContainerStyle={styles.scrollContent}
            showsVerticalScrollIndicator={false}
          >
            <Text style={[styles.title, { color: colors.text }]}>{providerName}</Text>
            <Text style={[styles.providerId, { color: colors.textSecondary }]}>
              Provider ID: {providerId}
            </Text>
            <Text style={[styles.description, { color: colors.textSecondary }]}>
              {providerDescription}
            </Text>

            {hasMultipleAccounts ? (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>Choose account</Text>
                {accounts?.map((account) => {
                  const isSelected = account.connectionId === selectedAccount?.connectionId;
                  return (
                    <TouchableOpacity
                      key={account.connectionId}
                      style={[
                        styles.accountRow,
                        {
                          backgroundColor: isSelected ? colors.primary : colors.background,
                          borderColor: isSelected ? colors.primary : colors.border,
                        },
                      ]}
                      activeOpacity={0.85}
                      onPress={() => setSelectedConnectionId(account.connectionId)}
                    >
                      <Text
                        style={[
                          styles.accountLabel,
                          { color: isSelected ? "#ffffff" : colors.text },
                        ]}
                      >
                        {account.label}
                      </Text>
                      {account.email ? (
                        <Text
                          style={[
                            styles.accountEmail,
                            { color: isSelected ? "rgba(255,255,255,0.8)" : colors.textSecondary },
                          ]}
                        >
                          {account.email}
                        </Text>
                      ) : null}
                    </TouchableOpacity>
                  );
                })}
              </View>
            ) : selectedAccount ? (
              <View style={styles.section}>
                <Text style={[styles.sectionTitle, { color: colors.text }]}>Connected account</Text>
                <View
                  style={[
                    styles.staticCard,
                    { backgroundColor: colors.background, borderColor: colors.border },
                  ]}
                >
                  <Text style={[styles.accountLabel, { color: colors.text }]}>
                    {selectedAccount.label}
                  </Text>
                  {selectedAccount.email ? (
                    <Text style={[styles.accountEmail, { color: colors.textSecondary }]}>
                      {selectedAccount.email}
                    </Text>
                  ) : null}
                </View>
              </View>
            ) : null}

            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>Requested scopes</Text>
              {scopes.length > 0 ? (
                scopes.map((scope) => (
                  <View
                    key={scope}
                    style={[
                      styles.listItem,
                      { backgroundColor: colors.background, borderColor: colors.border },
                    ]}
                  >
                    <Text style={[styles.listTitle, { color: colors.text }]}>{scope}</Text>
                    <Text style={[styles.listDescription, { color: colors.textSecondary }]}>
                      {scopeDescriptions?.[scope] ?? "No description provided."}
                    </Text>
                  </View>
                ))
              ) : (
                <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                  No scopes requested.
                </Text>
              )}
            </View>

            <View style={styles.section}>
              <Text style={[styles.sectionTitle, { color: colors.text }]}>API endpoints</Text>
              {endpoints && endpoints.length > 0 ? (
                endpoints.map((endpoint) => (
                  <View
                    key={`${endpoint.url}-${Array.isArray(endpoint.methods) ? endpoint.methods.join(",") : "*"}`}
                    style={[
                      styles.listItem,
                      { backgroundColor: colors.background, borderColor: colors.border },
                    ]}
                  >
                    <Text style={[styles.listTitle, { color: colors.text }]}>{endpoint.url}</Text>
                    <Text style={[styles.listDescription, { color: colors.textSecondary }]}>
                      Methods: {Array.isArray(endpoint.methods) ? endpoint.methods.join(", ") : "*"}
                    </Text>
                  </View>
                ))
              ) : (
                <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
                  No specific endpoints listed.
                </Text>
              )}
            </View>
          </ScrollView>

          <View style={[styles.actionRow, { borderTopColor: colors.border }]}>
            <TouchableOpacity
              style={[
                styles.secondaryButton,
                { backgroundColor: colors.background, borderColor: colors.border },
              ]}
              activeOpacity={0.85}
              onPress={onDeny}
            >
              <Text style={[styles.secondaryButtonText, { color: colors.text }]}>Deny</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.primaryButton, { backgroundColor: colors.primary }]}
              activeOpacity={0.85}
              onPress={handleApprove}
            >
              <Text style={styles.primaryButtonText}>Approve</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  modalRoot: {
    flex: 1,
    justifyContent: "flex-end",
  },
  backdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0, 0, 0, 0.45)",
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    borderWidth: 1,
    borderBottomWidth: 0,
    maxHeight: "85%",
    overflow: "hidden",
  },
  handle: {
    alignSelf: "center",
    width: 44,
    height: 5,
    borderRadius: 999,
    marginTop: 12,
    marginBottom: 8,
  },
  scrollView: {
    flexGrow: 0,
  },
  scrollContent: {
    paddingHorizontal: 20,
    paddingTop: 8,
    paddingBottom: 20,
  },
  title: {
    fontSize: 28,
    fontWeight: "bold",
    marginBottom: 6,
  },
  providerId: {
    fontSize: 13,
    marginBottom: 12,
  },
  description: {
    fontSize: 15,
    lineHeight: 22,
  },
  section: {
    marginTop: 24,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 12,
  },
  accountRow: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  staticCard: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
  },
  accountLabel: {
    fontSize: 15,
    fontWeight: "600",
  },
  accountEmail: {
    fontSize: 13,
    marginTop: 4,
  },
  listItem: {
    borderWidth: 1,
    borderRadius: 12,
    padding: 14,
    marginBottom: 10,
  },
  listTitle: {
    fontSize: 15,
    fontWeight: "600",
    marginBottom: 4,
  },
  listDescription: {
    fontSize: 14,
    lineHeight: 20,
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 20,
  },
  actionRow: {
    flexDirection: "row",
    paddingHorizontal: 20,
    paddingVertical: 16,
    borderTopWidth: 1,
  },
  secondaryButton: {
    flex: 1,
    height: 48,
    borderRadius: 8,
    borderWidth: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  secondaryButtonText: {
    fontSize: 16,
    fontWeight: "600",
  },
  primaryButton: {
    flex: 1,
    height: 48,
    borderRadius: 8,
    justifyContent: "center",
    alignItems: "center",
    marginLeft: 12,
  },
  primaryButtonText: {
    color: "#e0e0e0",
    fontSize: 16,
    fontWeight: "600",
  },
});
