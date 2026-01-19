/**
 * Keyboard Shortcuts Page - Shell panel showing available keyboard shortcuts.
 */

import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import { Theme, Card, Flex, Heading, Text, Box, Table, Kbd, ScrollArea } from "@radix-ui/themes";

interface ShortcutGroup {
  title: string;
  shortcuts: Array<{
    keys: string[];
    description: string;
  }>;
}

const shortcutGroups: ShortcutGroup[] = [
  {
    title: "General",
    shortcuts: [
      { keys: ["Cmd/Ctrl", "Shift", "M"], description: "Model Provider Config" },
      { keys: ["Cmd/Ctrl", "Shift", "O"], description: "Switch Workspace" },
      { keys: ["Cmd/Ctrl", "/"], description: "Show Keyboard Shortcuts" },
      { keys: ["Cmd/Ctrl", "Q"], description: "Quit Application" },
    ],
  },
  {
    title: "Navigation",
    shortcuts: [
      { keys: ["Cmd", "["], description: "Back (macOS)" },
      { keys: ["Cmd", "]"], description: "Forward (macOS)" },
      { keys: ["Alt", "Left"], description: "Back (Windows/Linux)" },
      { keys: ["Alt", "Right"], description: "Forward (Windows/Linux)" },
      { keys: ["Cmd/Ctrl", "R"], description: "Reload Current Panel" },
      { keys: ["Cmd/Ctrl", "Shift", "R"], description: "Force Reload" },
    ],
  },
  {
    title: "Developer",
    shortcuts: [
      { keys: ["Cmd/Ctrl", "Shift", "I"], description: "Toggle Panel DevTools" },
      { keys: ["Cmd/Ctrl", "Alt", "I"], description: "Toggle App DevTools" },
    ],
  },
  {
    title: "Window",
    shortcuts: [
      { keys: ["Cmd/Ctrl", "M"], description: "Minimize Window" },
      { keys: ["F11"], description: "Toggle Fullscreen" },
    ],
  },
  {
    title: "Edit",
    shortcuts: [
      { keys: ["Cmd/Ctrl", "Z"], description: "Undo" },
      { keys: ["Cmd/Ctrl", "Y"], description: "Redo" },
      { keys: ["Cmd/Ctrl", "X"], description: "Cut" },
      { keys: ["Cmd/Ctrl", "C"], description: "Copy" },
      { keys: ["Cmd/Ctrl", "V"], description: "Paste" },
      { keys: ["Cmd/Ctrl", "A"], description: "Select All" },
    ],
  },
];

function KeyboardShortcutsPage() {
  return (
    <Box p="4" style={{ maxWidth: "700px", margin: "0 auto" }}>
      <Heading size="7" mb="4">Keyboard Shortcuts</Heading>

      <ScrollArea style={{ height: "calc(100vh - 100px)" }}>
        <Flex direction="column" gap="4">
          {shortcutGroups.map((group) => (
            <Card key={group.title}>
              <Heading size="4" mb="3">{group.title}</Heading>
              <Table.Root>
                <Table.Body>
                  {group.shortcuts.map((shortcut, index) => (
                    <Table.Row key={index}>
                      <Table.Cell style={{ width: "200px" }}>
                        <Flex gap="1">
                          {shortcut.keys.map((key, keyIndex) => (
                            <span key={keyIndex}>
                              <Kbd>{key}</Kbd>
                              {keyIndex < shortcut.keys.length - 1 && (
                                <Text size="1" color="gray" mx="1">+</Text>
                              )}
                            </span>
                          ))}
                        </Flex>
                      </Table.Cell>
                      <Table.Cell>
                        <Text>{shortcut.description}</Text>
                      </Table.Cell>
                    </Table.Row>
                  ))}
                </Table.Body>
              </Table.Root>
            </Card>
          ))}
        </Flex>
      </ScrollArea>
    </Box>
  );
}

// Get theme from preload globals (passed via --natstack-theme arg)
declare const __natstackInitialTheme: "light" | "dark" | undefined;
const initialTheme = typeof __natstackInitialTheme !== "undefined" ? __natstackInitialTheme : "dark";

// Mount the app
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <Theme appearance={initialTheme} radius="medium">
      <KeyboardShortcutsPage />
    </Theme>
  );
}
