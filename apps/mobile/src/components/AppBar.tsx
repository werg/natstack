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

import React, { useCallback, useEffect, useState } from "react";
import { View, Text, StyleSheet, Pressable, ActionSheetIOS, Platform, Alert, TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue } from "jotai";
import { themeColorsAtom } from "../state/themeAtoms";
import { shellClientAtom } from "../state/shellClientAtom";

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
}: AppBarProps) {
  const insets = useSafeAreaInsets();
  const colors = useAtomValue(themeColorsAtom);
  const shellClient = useAtomValue(shellClientAtom);
  const [addressValue, setAddressValue] = useState(address);

  useEffect(() => {
    setAddressValue(address);
  }, [address]);

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
        >
          {title}
        </Text>

        <Pressable
          onPress={onToggleAddressBar}
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
            value={addressValue}
            onChangeText={setAddressValue}
            onSubmitEditing={() => onNavigateAddress?.(addressValue)}
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
    </View>
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
  metadataText: {
    maxWidth: 120,
    fontSize: 11,
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
