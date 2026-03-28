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

import React, { useCallback } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
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
}

export function AppBar({ title, onMenuPress, onPanelCreated }: AppBarProps) {
  const insets = useSafeAreaInsets();
  const colors = useAtomValue(themeColorsAtom);
  const shellClient = useAtomValue(shellClientAtom);

  const handleCreatePanel = useCallback(async () => {
    if (!shellClient) return;
    try {
      const result = await shellClient.panels.createAboutPanel("browser");
      onPanelCreated?.(result.id);
    } catch {
      // Creation failed (offline, etc.) -- silently ignore for now
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
        >
          {title}
        </Text>

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
  plusIcon: {
    fontSize: 28,
    fontWeight: "300",
    lineHeight: 30,
  },
});
