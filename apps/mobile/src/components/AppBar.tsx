/**
 * AppBar -- Top navigation bar for the mobile shell.
 *
 * Layout:
 *   [Hamburger]  [Panel Title]  [+ New Panel]
 *
 * Features:
 * - Left: hamburger menu button to open the panel drawer
 * - Center: current panel title (or "NatStack" if no panel selected)
 * - Right: "+" button to create a new panel
 * - Uses safe area insets for status bar spacing
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActionSheetIOS, Platform, Alert, TextInput, Modal, FlatList } from "react-native";
import type { StyleProp, TextStyle } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue } from "jotai";
import { themeColorsAtom } from "../state/themeAtoms";
import { shellClientAtom } from "../state/shellClientAtom";
import { splitTextByMatchRanges, type AddressAutocompleteItem, type TextMatchRange } from "@natstack/shared/panelChrome";
import type { BranchInfo, CommitInfo } from "@natstack/shared/types";

interface AppBarProps {
  /** Title to display in the center */
  title: string;
  /** Called when the hamburger menu button is pressed */
  onMenuPress: () => void;
  /** Called after a new panel is created, with the new panel's ID */
  onPanelCreated?: (panelId: string) => void;
  addressBarVisible?: boolean;
  address?: string;
  metadata?: string | null;
  isLoading?: boolean;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onToggleAddressBar?: () => void;
  onBack?: () => void;
  onForward?: () => void;
  onReload?: () => void;
  onStop?: () => void;
  onNavigateAddress?: (value: string) => void;
  addressSuggestions?: AddressAutocompleteItem[];
  onAddressQueryChange?: (value: string) => void;
  onSelectAddressSuggestion?: (item: AddressAutocompleteItem) => void;
  chromeKind?: "panel" | "browser";
  branches?: BranchInfo[];
  commits?: CommitInfo[];
  selectedBranch?: string | null;
  selectedCommit?: string | null;
  dirty?: boolean;
  onSelectBranch?: (branch: string) => void;
  onSelectCommit?: (commit: string) => void;
  onShowActions?: () => void;
}

export function AppBar({
  title,
  onMenuPress,
  onPanelCreated,
  addressBarVisible = false,
  address = "",
  metadata = null,
  isLoading = false,
  canGoBack = false,
  canGoForward = false,
  onToggleAddressBar,
  onBack,
  onForward,
  onReload,
  onStop,
  onNavigateAddress,
  addressSuggestions = [],
  onAddressQueryChange,
  onSelectAddressSuggestion,
  chromeKind,
  branches = [],
  commits = [],
  selectedBranch,
  selectedCommit,
  dirty = false,
  onSelectBranch,
  onSelectCommit,
  onShowActions,
}: AppBarProps) {
  const insets = useSafeAreaInsets();
  const colors = useAtomValue(themeColorsAtom);
  const shellClient = useAtomValue(shellClientAtom);
  const [addressValue, setAddressValue] = useState(address);
  const [addressFocused, setAddressFocused] = useState(false);
  const [picker, setPicker] = useState<"branch" | "commit" | null>(null);
  const [pickerQuery, setPickerQuery] = useState("");
  const visibleSuggestions = useMemo(() => addressFocused ? addressSuggestions.slice(0, 8) : [], [addressFocused, addressSuggestions]);
  const visibleBranches = useMemo(() => {
    const query = pickerQuery.trim().toLowerCase();
    return branches.filter((branch) => !query || branch.name.toLowerCase().includes(query));
  }, [branches, pickerQuery]);
  const visibleCommits = useMemo(() => {
    const query = pickerQuery.trim().toLowerCase();
    return commits.filter((commit) =>
      !query ||
      commit.oid.toLowerCase().includes(query) ||
      commit.message.toLowerCase().includes(query) ||
      commit.author.name.toLowerCase().includes(query)
    );
  }, [commits, pickerQuery]);

  useEffect(() => {
    setAddressValue(address);
  }, [address]);

  useEffect(() => {
    if (addressBarVisible) onAddressQueryChange?.(addressValue);
  }, [addressBarVisible, addressValue, onAddressQueryChange]);

  const handleCreatePanel = useCallback(() => {
    if (!shellClient) return;

    const createPanel = async (type: "new" | "browser") => {
      try {
        const result = await shellClient.panels.createAboutPanel(type);
        onPanelCreated?.(result.id);
      } catch (error) {
        Alert.alert(
          "Panel Creation Failed",
          error instanceof Error ? error.message : "Could not create panel.",
        );
      }
    };

    if (Platform.OS === "ios") {
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: ["New Panel", "Browser", "Cancel"],
          cancelButtonIndex: 2,
        },
        (buttonIndex) => {
          if (buttonIndex === 0) createPanel("new");
          else if (buttonIndex === 1) createPanel("browser");
        },
      );
    } else {
      Alert.alert("Create Panel", undefined, [
        { text: "New Panel", onPress: () => createPanel("new") },
        { text: "Browser", onPress: () => createPanel("browser") },
        { text: "Cancel", style: "cancel" },
      ]);
    }
  }, [shellClient, onPanelCreated]);

  return (
    <View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
          backgroundColor: colors.surface,
          borderBottomColor: colors.border,
        },
      ]}
    >
      <View style={styles.content}>
        {/* Hamburger menu button */}
        <Pressable
          onPress={onMenuPress}
          style={styles.iconButton}
          hitSlop={8}
          accessibilityLabel="Open panel drawer"
          accessibilityRole="button"
        >
          <View style={styles.hamburger}>
            <View style={[styles.hamburgerLine, { backgroundColor: colors.text }]} />
            <View style={[styles.hamburgerLine, { backgroundColor: colors.text }]} />
            <View style={[styles.hamburgerLine, { backgroundColor: colors.text }]} />
          </View>
        </Pressable>

        {/* Panel title */}
        <Text
          style={[styles.title, { color: colors.text }]}
          numberOfLines={1}
          ellipsizeMode="tail"
          onPress={onToggleAddressBar}
          onLongPress={onShowActions}
        >
          {title}
        </Text>

        <Pressable
          onPress={onToggleAddressBar}
          onLongPress={onShowActions}
          style={styles.urlButton}
          hitSlop={8}
          accessibilityLabel={addressBarVisible ? "Hide address bar" : "Show address bar"}
          accessibilityRole="button"
        >
          <Text style={[styles.urlButtonText, { color: colors.textSecondary }]}>URL</Text>
        </Pressable>

        {/* Create new panel button */}
        <Pressable
          onPress={handleCreatePanel}
          style={styles.iconButton}
          hitSlop={8}
          accessibilityLabel="Create new panel"
          accessibilityRole="button"
        >
          <Text style={[styles.plusIcon, { color: colors.text }]}>+</Text>
        </Pressable>
      </View>
      {addressBarVisible && (
        <View style={[styles.addressRow, { borderTopColor: colors.border }]}>
          <Pressable
            onPress={onBack}
            disabled={!canGoBack}
            style={[styles.navButton, !canGoBack && styles.disabledButton]}
            accessibilityLabel="Back"
            accessibilityRole="button"
          >
            <Text style={[styles.navButtonText, { color: colors.text }]}>{"<"}</Text>
          </Pressable>
          <Pressable
            onPress={onForward}
            disabled={!canGoForward}
            style={[styles.navButton, !canGoForward && styles.disabledButton]}
            accessibilityLabel="Forward"
            accessibilityRole="button"
          >
            <Text style={[styles.navButtonText, { color: colors.text }]}>{">"}</Text>
          </Pressable>
          <TextInput
            testID="address-input"
            value={addressValue}
            onFocus={() => {
              setAddressFocused(true);
              onAddressQueryChange?.(addressValue);
            }}
            onBlur={() => {
              setTimeout(() => setAddressFocused(false), 120);
            }}
            onChangeText={(text) => {
              setAddressValue(text);
              onAddressQueryChange?.(text);
            }}
            onSubmitEditing={() => {
              setAddressFocused(false);
              onNavigateAddress?.(addressValue);
            }}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="go"
            selectTextOnFocus
            style={[
              styles.addressInput,
              {
                color: colors.text,
                backgroundColor: colors.background,
                borderColor: colors.border,
              },
            ]}
            placeholder="Search or enter address"
            placeholderTextColor={colors.textSecondary}
          />
          {metadata && (
            <Text
              style={[styles.metadataText, { color: colors.textSecondary }]}
              numberOfLines={1}
              ellipsizeMode="middle"
            >
              {metadata}
            </Text>
          )}
          {chromeKind === "panel" && (
            <>
              <Pressable
                onPress={() => { setPicker("branch"); setPickerQuery(""); }}
                testID="branch-picker-button"
                style={[styles.refChip, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel="Select branch"
              >
                <Text style={[styles.refChipText, { color: colors.text }]} numberOfLines={1}>
                  {selectedBranch ?? "HEAD"}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => { setPicker("commit"); setPickerQuery(""); }}
                testID="commit-picker-button"
                style={[styles.refChip, { borderColor: colors.border }]}
                accessibilityRole="button"
                accessibilityLabel="Select commit"
              >
                <Text style={[styles.refChipText, { color: colors.text }]} numberOfLines={1}>
                  {selectedCommit ? selectedCommit.slice(0, 7) : "commit"}
                </Text>
              </Pressable>
              {dirty && <Text style={[styles.dirtyText, { color: colors.textSecondary }]}>dirty</Text>}
            </>
          )}
          <Pressable
            onPress={isLoading ? onStop : onReload}
            style={styles.navButton}
            accessibilityLabel={isLoading ? "Stop loading" : "Reload"}
            accessibilityRole="button"
          >
            <Text style={[styles.navButtonText, { color: colors.text }]}>{isLoading ? "x" : "R"}</Text>
          </Pressable>
        </View>
      )}
      {addressBarVisible && visibleSuggestions.length > 0 && (
        <View
          style={[
            styles.suggestions,
            {
              backgroundColor: colors.surface,
              borderTopColor: colors.border,
              borderBottomColor: colors.border,
            },
          ]}
        >
          {visibleSuggestions.map((item, index) => (
            <Pressable
              key={`${item.kind}:${item.value}`}
              testID={`address-suggestion-${index}`}
              onPress={() => {
                setAddressValue(item.value);
                setAddressFocused(false);
                onSelectAddressSuggestion?.(item);
              }}
              style={styles.suggestionRow}
              accessibilityRole="button"
              accessibilityLabel={item.label}
            >
              <View style={styles.suggestionContent}>
                <Text style={[styles.suggestionIcon, { color: colors.textSecondary }]}>{iconText(item.iconKind)}</Text>
                <View style={styles.suggestionText}>
                  <HighlightedText
                    text={item.label}
                    ranges={item.matchRanges?.label}
                    style={[styles.suggestionLabel, { color: colors.text }]}
                    highlightStyle={styles.suggestionMatch}
                  />
                  <HighlightedText
                    text={item.meta}
                    ranges={item.matchRanges?.meta}
                    style={[styles.suggestionMeta, { color: colors.textSecondary }]}
                    highlightStyle={styles.suggestionMatch}
                  />
                </View>
              </View>
            </Pressable>
          ))}
        </View>
      )}
      <Modal
        visible={picker !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setPicker(null)}
      >
        <Pressable style={styles.modalBackdrop} onPress={() => setPicker(null)} />
        <View style={[styles.sheet, { backgroundColor: colors.surface, borderColor: colors.border }]}>
          <TextInput
            testID="ref-picker-input"
            value={pickerQuery}
            onChangeText={setPickerQuery}
            autoCapitalize="none"
            autoCorrect={false}
            style={[styles.pickerInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.background }]}
            placeholder={picker === "branch" ? "Search branches" : "Search commits"}
            placeholderTextColor={colors.textSecondary}
          />
          {picker === "branch" ? (
            <FlatList
              keyboardShouldPersistTaps="handled"
              data={visibleBranches}
              keyExtractor={(item) => item.name}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.pickerRow}
                  testID={`branch-option-${item.name}`}
                  onPress={() => {
                    onSelectBranch?.(item.name);
                    setPicker(null);
                  }}
                >
                  <Text style={[styles.pickerLabel, { color: colors.text }]} numberOfLines={1}>
                    {item.name}{item.current ? "  current" : ""}
                  </Text>
                </Pressable>
              )}
            />
          ) : (
            <FlatList
              keyboardShouldPersistTaps="handled"
              data={visibleCommits}
              keyExtractor={(item) => item.oid}
              renderItem={({ item }) => (
                <Pressable
                  style={styles.pickerRow}
                  testID={`commit-option-${item.oid}`}
                  onPress={() => {
                    onSelectCommit?.(item.oid);
                    setPicker(null);
                  }}
                >
                  <Text style={[styles.pickerLabel, { color: colors.text }]} numberOfLines={1}>
                    {item.oid.slice(0, 7)} {item.message}
                  </Text>
                  <Text style={[styles.pickerMeta, { color: colors.textSecondary }]} numberOfLines={1}>
                    {item.author.name}
                  </Text>
                </Pressable>
              )}
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

function iconText(kind: AddressAutocompleteItem["iconKind"]): string {
  return ({ globe: "go", history: "h", bookmark: "*", search: "?", session: "s", panel: "p", branch: "br", commit: "c" } as Record<string, string>)[kind] ?? "-";
}

function HighlightedText({
  text,
  ranges,
  style,
  highlightStyle,
}: {
  text: string;
  ranges?: TextMatchRange[];
  style: StyleProp<TextStyle>;
  highlightStyle: StyleProp<TextStyle>;
}) {
  return (
    <Text style={style} numberOfLines={1}>
      {splitTextByMatchRanges(text, ranges).map((part, index) => (
        <Text key={`${index}:${part.text}`} style={part.highlighted ? highlightStyle : undefined}>
          {part.text}
        </Text>
      ))}
    </Text>
  );
}

const styles = StyleSheet.create({
  container: {
    borderBottomWidth: 1,
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    height: 48,
    paddingHorizontal: 8,
  },
  addressRow: {
    height: 44,
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 8,
    gap: 6,
  },
  addressInput: {
    flex: 1,
    height: 32,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 14,
  },
  suggestions: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 4,
  },
  suggestionRow: {
    minHeight: 44,
    justifyContent: "center",
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  suggestionContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  suggestionIcon: {
    width: 22,
    fontSize: 11,
    fontWeight: "700",
    textAlign: "center",
  },
  suggestionText: {
    flex: 1,
    minWidth: 0,
  },
  suggestionLabel: {
    fontSize: 14,
    fontWeight: "500",
  },
  suggestionMeta: {
    marginTop: 2,
    fontSize: 12,
  },
  suggestionMatch: {
    fontWeight: "800",
  },
  metadataText: {
    maxWidth: 120,
    fontSize: 11,
  },
  refChip: {
    maxWidth: 82,
    height: 28,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 6,
  },
  refChipText: {
    fontSize: 11,
    fontWeight: "600",
  },
  dirtyText: {
    fontSize: 10,
  },
  modalBackdrop: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.35)",
  },
  sheet: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    maxHeight: "70%",
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: 12,
  },
  pickerInput: {
    height: 38,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    fontSize: 14,
    marginBottom: 8,
  },
  pickerRow: {
    minHeight: 44,
    justifyContent: "center",
    paddingVertical: 8,
  },
  pickerLabel: {
    fontSize: 14,
    fontWeight: "500",
  },
  pickerMeta: {
    marginTop: 2,
    fontSize: 12,
  },
  navButton: {
    width: 34,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },
  navButtonText: {
    fontSize: 18,
    fontWeight: "600",
  },
  disabledButton: {
    opacity: 0.35,
  },
  iconButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  hamburger: {
    width: 22,
    height: 16,
    justifyContent: "space-between",
  },
  hamburgerLine: {
    width: 22,
    height: 2,
    borderRadius: 1,
  },
  title: {
    flex: 1,
    fontSize: 17,
    fontWeight: "600",
    textAlign: "center",
    marginHorizontal: 8,
  },
  urlButton: {
    paddingHorizontal: 6,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  urlButtonText: {
    fontSize: 11,
    fontWeight: "700",
  },
  plusIcon: {
    fontSize: 28,
    fontWeight: "300",
    lineHeight: 30,
  },
});
