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
import { View, Text, StyleSheet, FlatList, RefreshControl } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAtomValue, useSetAtom } from "jotai";
import { shellClientAtom, panelTreeAtom } from "../state/shellClientAtom";
import { themeColorsAtom } from "../state/themeAtoms";
import { activePanelIdAtom } from "../state/navigationAtoms";
import { PanelTreeItem, type FlatPanelItem } from "./PanelTreeItem";
import type { Panel } from "@shared/types";

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

export function PanelDrawer({ onSelectPanel }: PanelDrawerProps) {
  const shellClient = useAtomValue(shellClientAtom);
  const panelTree = useAtomValue(panelTreeAtom);
  const setPanelTree = useSetAtom(panelTreeAtom);
  const colors = useAtomValue(themeColorsAtom);
  const activePanelId = useAtomValue(activePanelIdAtom);
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

  const renderItem = useCallback(
    ({ item }: { item: FlatPanelItem }) => (
      <PanelTreeItem
        item={item}
        isActive={item.id === activePanelId}
        colors={colors}
        onPress={handlePanelPress}
        onToggleCollapse={handleToggleCollapse}
        onArchive={handleArchive}
      />
    ),
    [activePanelId, colors, handlePanelPress, handleToggleCollapse, handleArchive],
  );

  const keyExtractor = useCallback((item: FlatPanelItem) => item.id, []);

  return (
    <View style={[styles.container, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <View style={[styles.header, { borderBottomColor: colors.border }]}>
        <Text style={[styles.headerTitle, { color: colors.text }]}>Panels</Text>
      </View>

      {flatItems.length === 0 ? (
        <View style={styles.emptyContainer}>
          <Text style={[styles.emptyText, { color: colors.textSecondary }]}>
            No panels yet.
          </Text>
        </View>
      ) : (
        <FlatList
          data={flatItems}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          contentContainerStyle={styles.listContent}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={handleRefresh}
              tintColor={colors.textSecondary}
            />
          }
        />
      )}
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
  emptyText: {
    fontSize: 14,
    textAlign: "center",
    lineHeight: 22,
  },
});
