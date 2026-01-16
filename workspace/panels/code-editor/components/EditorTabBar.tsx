/**
 * Tab bar for the code editor.
 *
 * Displays open file tabs with modified indicators and close buttons.
 */

import { Flex, Text, IconButton, Box } from "@radix-ui/themes";
import { Cross2Icon } from "@radix-ui/react-icons";
import type { Tab } from "../types";

const TAB_STYLE = {
  MAX_FILENAME_WIDTH_PX: 150,
} as const;

export interface EditorTabBarProps {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
}

export function EditorTabBar({
  tabs,
  activeId,
  onSelect,
  onClose,
}: EditorTabBarProps) {
  if (tabs.length === 0) {
    return null;
  }

  return (
    <Flex
      style={{
        borderBottom: "1px solid var(--gray-6)",
        backgroundColor: "var(--gray-2)",
        minHeight: 36,
        overflow: "hidden",
      }}
    >
      <Flex
        style={{
          overflow: "auto",
          flex: 1,
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;

          return (
            <Flex
              key={tab.id}
              align="center"
              gap="1"
              onClick={() => onSelect(tab.id)}
              style={{
                padding: "6px 8px",
                cursor: "pointer",
                userSelect: "none",
                borderRight: "1px solid var(--gray-5)",
                backgroundColor: isActive ? "var(--gray-1)" : "transparent",
                borderBottom: isActive ? "2px solid var(--accent-9)" : "2px solid transparent",
                minWidth: 0,
                flexShrink: 0,
              }}
            >
              {/* Modified indicator */}
              <Box
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  backgroundColor: tab.isModified ? "var(--accent-9)" : "transparent",
                  flexShrink: 0,
                }}
              />

              {/* File name */}
              <Text
                size="1"
                weight={isActive ? "medium" : "regular"}
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  maxWidth: TAB_STYLE.MAX_FILENAME_WIDTH_PX,
                }}
              >
                {tab.fileName}
              </Text>

              {/* Close button */}
              <IconButton
                size="1"
                variant="ghost"
                color="gray"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                style={{
                  width: 18,
                  height: 18,
                  flexShrink: 0,
                }}
              >
                <Cross2Icon width={12} height={12} />
              </IconButton>
            </Flex>
          );
        })}
      </Flex>
    </Flex>
  );
}
