/**
 * PanelTreeItem -- Individual tree node in the panel drawer.
 *
 * Renders a single panel entry with:
 * - Indentation based on tree depth
 * - Panel title (truncated if too long)
 * - Expand/collapse chevron for panels with children
 * - Active panel highlight
 * - Swipe-to-archive gesture (swipe left reveals "Archive" action)
 */

import React, { useCallback } from "react";
import { View, Text, StyleSheet, Pressable } from "react-native";
import {
  Gesture,
  GestureDetector,
  type PanGestureHandlerEventPayload,
} from "react-native-gesture-handler";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  runOnJS,
  interpolate,
  Extrapolation,
} from "react-native-reanimated";

const INDENT_PER_LEVEL = 16;
const ARCHIVE_THRESHOLD = -120;
const ITEM_HEIGHT = 48;

export interface FlatPanelItem {
  id: string;
  title: string;
  depth: number;
  childCount: number;
  isCollapsed: boolean;
}

interface PanelTreeItemProps {
  item: FlatPanelItem;
  isActive: boolean;
  colors: {
    surface: string;
    text: string;
    textSecondary: string;
    primary: string;
    danger: string;
    background: string;
  };
  onPress: (panelId: string) => void;
  onToggleCollapse: (panelId: string, collapsed: boolean) => void;
  onArchive: (panelId: string) => void;
}

export function PanelTreeItem({
  item,
  isActive,
  colors,
  onPress,
  onToggleCollapse,
  onArchive,
}: PanelTreeItemProps) {
  const translateX = useSharedValue(0);
  const itemHeight = useSharedValue(ITEM_HEIGHT);
  const itemOpacity = useSharedValue(1);

  const handleArchive = useCallback(() => {
    // Animate removal then call archive
    itemHeight.value = withTiming(0, { duration: 250 });
    itemOpacity.value = withTiming(0, { duration: 200 }, () => {
      runOnJS(onArchive)(item.id);
    });
  }, [item.id, onArchive, itemHeight, itemOpacity]);

  const panGesture = Gesture.Pan()
    .activeOffsetX([-10, 10])
    .failOffsetY([-5, 5])
    .onUpdate((event: PanGestureHandlerEventPayload) => {
      // Only allow swiping left (negative translateX)
      if (event.translationX < 0) {
        translateX.value = event.translationX;
      }
    })
    .onEnd((event: PanGestureHandlerEventPayload) => {
      if (event.translationX < ARCHIVE_THRESHOLD) {
        // Past threshold -- commit archive
        translateX.value = withTiming(-400, { duration: 200 });
        runOnJS(handleArchive)();
      } else {
        // Snap back
        translateX.value = withTiming(0, { duration: 200 });
      }
    });

  const rowAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
  }));

  const archiveBackgroundStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      translateX.value,
      [-ARCHIVE_THRESHOLD, 0],
      [1, 0],
      Extrapolation.CLAMP,
    ),
  }));

  const containerAnimatedStyle = useAnimatedStyle(() => ({
    height: itemHeight.value,
    opacity: itemOpacity.value,
  }));

  const handlePress = useCallback(() => {
    onPress(item.id);
  }, [item.id, onPress]);

  const handleChevronPress = useCallback(() => {
    onToggleCollapse(item.id, !item.isCollapsed);
  }, [item.id, item.isCollapsed, onToggleCollapse]);

  return (
    <Animated.View style={[styles.outerContainer, containerAnimatedStyle]}>
      {/* Archive background revealed on swipe */}
      <Animated.View
        style={[
          styles.archiveBackground,
          { backgroundColor: colors.danger },
          archiveBackgroundStyle,
        ]}
      >
        <Text style={styles.archiveText}>Archive</Text>
      </Animated.View>

      <GestureDetector gesture={panGesture}>
        <Animated.View
          style={[
            styles.row,
            {
              backgroundColor: isActive ? colors.primary : colors.surface,
              paddingLeft: 12 + item.depth * INDENT_PER_LEVEL,
            },
            rowAnimatedStyle,
          ]}
        >
          {/* Expand/collapse chevron */}
          {item.childCount > 0 ? (
            <Pressable
              onPress={handleChevronPress}
              style={styles.chevronButton}
              hitSlop={8}
            >
              <Text
                style={[
                  styles.chevron,
                  { color: isActive ? "#ffffff" : colors.textSecondary },
                ]}
              >
                {item.isCollapsed ? "\u25B6" : "\u25BC"}
              </Text>
            </Pressable>
          ) : (
            <View style={styles.chevronSpacer} />
          )}

          {/* Panel title */}
          <Pressable
            onPress={handlePress}
            style={styles.titlePressable}
          >
            <Text
              style={[
                styles.title,
                { color: isActive ? "#ffffff" : colors.text },
              ]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {item.title}
            </Text>
          </Pressable>

          {/* Child count badge */}
          {item.childCount > 0 && (
            <Text
              style={[
                styles.childCount,
                { color: isActive ? "rgba(255,255,255,0.7)" : colors.textSecondary },
              ]}
            >
              {item.childCount}
            </Text>
          )}
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  outerContainer: {
    overflow: "hidden",
    marginVertical: 1,
  },
  archiveBackground: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    paddingRight: 20,
    borderRadius: 6,
  },
  archiveText: {
    color: "#ffffff",
    fontSize: 14,
    fontWeight: "600",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    height: ITEM_HEIGHT,
    borderRadius: 6,
    paddingRight: 12,
  },
  chevronButton: {
    width: 24,
    height: 24,
    alignItems: "center",
    justifyContent: "center",
  },
  chevronSpacer: {
    width: 24,
  },
  chevron: {
    fontSize: 10,
  },
  titlePressable: {
    flex: 1,
    justifyContent: "center",
    marginLeft: 4,
  },
  title: {
    fontSize: 15,
  },
  childCount: {
    fontSize: 12,
    marginLeft: 8,
  },
});
