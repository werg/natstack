/**
 * PanelDrawer -- Drawer content showing the panel tree as a FlatList.
 *
 * Uses `panelShell.getTree()` to get the tree, flattens it with
 * depth/indent levels, and renders PanelTreeItem for each node.
 *
 * Features:
 * - Flattened tree with collapse/expand
 * - Pull-to-refresh (re-reads tree from local registry)
 * - Tapping an item selects that panel and closes the drawer
 * - Swipe-to-archive on individual items
 */

import React, { useCallback, useMemo, useState } from "react";
import { View, Text, StyleSheet, FlatList, RefreshControl, Pressable, Alert, ActionSheetIOS, Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useNavigation } from "@react-navigation/native";
import { useAtomValue, useSetAtom } from "jotai";
import { shellClientAtom, panelTreeAtom } from "../state/shellClientAtom";
import { themeColorsAtom } from "../state/themeAtoms";
import { activePanelIdAtom } from "../state/navigationAtoms";
import { PanelTreeItem, type FlatPanelItem } from "./PanelTreeItem";
import type { Panel } from "@natstack/shared/types";
import { buildPanelChromeState, isBrowserPanelSource } from "@natstack/shared/panelChrome";
import { getAvailablePanelCommands, type PanelCommandId } from "@natstack/shared/panelCommands";
import { getCurrentSnapshot } from "@natstack/shared/panel/accessors";
import { copyToClipboard, openExternalUrl } from "../services/nativeCapabilities";

interface PanelDrawerProps {
  /** Called when a panel is selected; parent should close the drawer */
  onSelectPanel: (panelId: string) => void;
}

/**
 * Flatten the panel tree into a list respecting collapsed state.
 * Collapsed panels' children are hidden from the list.
 */
function flattenTree(
  panels: Panel[],
  collapsedIds: Set<string>,
  depth = 0,
): FlatPanelItem[] {
  const result: FlatPanelItem[] = [];
  for (const panel of panels) {
    const isCollapsed = collapsedIds.has(panel.id);
    result.push({
      id: panel.id,
      title: panel.title,
      depth,
      childCount: panel.children.length,
      isCollapsed,
    });
    // Only recurse into children if not collapsed
    if (panel.children.length > 0 && !isCollapsed) {
      result.push(...flattenTree(panel.children, collapsedIds, depth + 1));
    }
  }
  return result;
}

function findPanelById(panels: Panel[], panelId: string): Panel | null {
  for (const panel of panels) {
    if (panel.id === panelId) return panel;
    const child = findPanelById(panel.children, panelId);
    if (child) return child;
  }
  return null;
}

export function PanelDrawer({ onSelectPanel }: PanelDrawerProps) {
  const shellClient = useAtomValue(shellClientAtom);
  const panelTree = useAtomValue(panelTreeAtom);
  const setPanelTree = useSetAtom(panelTreeAtom);
  const colors = useAtomValue(themeColorsAtom);
  const activePanelId = useAtomValue(activePanelIdAtom);
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [refreshing, setRefreshing] = useState(false);

  // Build the collapsed set from the shell client's registry
  const collapsedIds = useMemo(() => {
    if (!shellClient) return new Set<string>();
    return new Set(shellClient.panels.getCollapsedIds());
  }, [shellClient, panelTree]); // panelTree dependency triggers re-compute on tree changes

  // Flatten tree with collapse awareness
  const flatItems = useMemo(
    () => flattenTree(panelTree, collapsedIds),
    [panelTree, collapsedIds],
  );

  const handleRefresh = useCallback(async () => {
    if (!shellClient) return;
    setRefreshing(true);
    try {
      // Re-init forces a fresh fetch from the server
      await shellClient.panels.refresh();
      // Update the atom so the UI re-renders with the new tree
      setPanelTree(shellClient.panels.getTree());
    } catch {
      // Offline -- ignore
    }
    setRefreshing(false);
  }, [shellClient, setPanelTree]);

  const handlePanelPress = useCallback(
    (panelId: string) => {
      onSelectPanel(panelId);
    },
    [onSelectPanel],
  );

  const handleToggleCollapse = useCallback(
    (panelId: string, collapsed: boolean) => {
      if (!shellClient) return;
      void shellClient.panels.setCollapsed(panelId, collapsed);
    },
    [shellClient],
  );

  const handleArchive = useCallback(
    (panelId: string) => {
      if (!shellClient) return;
      void shellClient.panels.archive(panelId);
    },
    [shellClient],
  );

  const performPanelCommand = useCallback((command: PanelCommandId, panelId: string) => {
    if (!shellClient) return;
    const panel = findPanelById(panelTree, panelId);
    if (!panel) return;
    const snapshot = getCurrentSnapshot(panel);

    switch (command) {
      case "copy-address":
        copyToClipboard(snapshot.source);
        return;
      case "open-external": {
        const url = snapshot.resolvedUrl ?? (isBrowserPanelSource(snapshot.source) ? snapshot.source.slice("browser:".length) : null);
        if (url && /^https?:\/\//i.test(url)) void openExternalUrl(url);
        return;
      }
      case "duplicate":
        if (isBrowserPanelSource(snapshot.source)) {
          void shellClient.panels.createBrowserUrlPanel(null, snapshot.source.slice("browser:".length), { focus: true })
            .then((result) => onSelectPanel(result.id));
        } else {
          void shellClient.panels.createRootPanel(snapshot.source)
            .then((result) => onSelectPanel(result.id));
        }
        return;
      case "archive":
        void shellClient.panels.archive(panelId).then(() => {
          setPanelTree(shellClient.panels.getTree());
        });
        return;
      default:
        onSelectPanel(panelId);
    }
  }, [onSelectPanel, panelTree, setPanelTree, shellClient]);

  const handlePanelLongPress = useCallback((panelId: string) => {
    const panel = findPanelById(panelTree, panelId);
    if (!panel) return;
    const commands = getAvailablePanelCommands({ chrome: buildPanelChromeState({ panel }) }, [
      "copy-address",
      "open-external",
      "duplicate",
      "archive",
    ]);
    const labels = commands.map((command) => command.label);
    if (Platform.OS === "ios") {
      const destructiveIndex = commands.findIndex((command) => command.id === "archive");
      ActionSheetIOS.showActionSheetWithOptions(
        {
          options: [...labels, "Cancel"],
          cancelButtonIndex: labels.length,
          destructiveButtonIndex: destructiveIndex >= 0 ? destructiveIndex : undefined,
        },
        (buttonIndex) => {
          const command = commands[buttonIndex];
          if (command) performPanelCommand(command.id, panelId);
        },
      );
      return;
    }
    Alert.alert(panel.title, undefined, [
      ...commands.map((command) => ({
        text: command.label,
        onPress: () => performPanelCommand(command.id, panelId),
        style: command.id === "archive" ? "destructive" as const : "default" as const,
      })),
      { text: "Cancel", style: "cancel" },
    ]);
  }, [panelTree, performPanelCommand]);

  const handleSettingsPress = useCallback(() => {
    navigation.getParent()?.navigate("Settings" as never);
  }, [navigation]);

  const renderItem = useCallback(
    ({ item }: { item: FlatPanelItem }) => (
      <PanelTreeItem
        item={item}
        isActive={item.id === activePanelId}
        colors={colors}
        onPress={handlePanelPress}
        onLongPress={handlePanelLongPress}
        onToggleCollapse={handleToggleCollapse}
        onArchive={handleArchive}
      />
    ),
    [activePanelId, colors, handlePanelPress, handlePanelLongPress, handleToggleCollapse, handleArchive],
  );

  const keyExtractor = useCallback((item: FlatPanelItem) => item.id, []);

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Panels</Text>
      </View>

      {flatItems.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyTitle, { color: colors.text }]}>No panels open yet</Text>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            Tap the address bar at the top of the screen and enter a URL or panel
            source to open your first panel.
          </Text>
        </View>
      ) : (
        <FlatList
          data={flatItems}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          style={{ flex: 1 }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.textSecondary}
            />
          }
        />
      )}

      <View style={[styles.footer, { borderTopColor: colors.border }]}>
        <Pressable
          onPress={handleSettingsPress}
          style={styles.footerButton}
          hitSlop={8}
        >
          <Text style={[styles.footerIcon, { color: colors.textSecondary }]}>{"\u2699"}</Text>
          <Text style={[styles.footerText, { color: colors.textSecondary }]}>Settings</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
  },
  headerTitle: {
    fontSize: 18,
    fontWeight: "bold",
  },
  listContent: {
    padding: 8,
  },
  emptyContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    padding: 32,
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: "600",
    textAlign: "center",
    marginBottom: 8,
  },
  emptyText: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
  },
  footer: {
    borderTopWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  footerButton: {
    flexDirection: "row",
    alignItems: "center",
  },
  footerIcon: {
    fontSize: 18,
    marginRight: 8,
  },
  footerText: {
    fontSize: 15,
  },
});
