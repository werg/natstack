/**
 * Keyboard Shortcuts Page - Shell panel showing available keyboard shortcuts.
 *
 * The shortcut list mirrors the accelerators registered in src/main/menu.ts.
 * Keys are rendered platform-aware: symbols (⌘⇧⌥) on macOS, text elsewhere.
 */
import { Flex, Text, Kbd, Separator } from "@radix-ui/themes";
import { Fragment } from "react";
import { KeyboardIcon } from "@radix-ui/react-icons";
import { mountAboutPanel, AboutPage, Section } from "@workspace/about-shared/ui";

const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform ?? "");

interface Shortcut {
  description: string;
  /** Key tokens in macOS symbol notation, e.g. ["⌘", "⇧", "O"]. */
  mac: string[];
  /** Override for Windows/Linux when not a simple symbol translation. */
  other?: string[];
  /** Restrict the shortcut to one platform. */
  platform?: "mac" | "other";
}

interface ShortcutGroup {
  title: string;
  shortcuts: Shortcut[];
}

const SYMBOL_TO_TEXT: Record<string, string> = { "⌘": "Ctrl", "⇧": "Shift", "⌥": "Alt", "⌃": "Ctrl" };

function keysFor(shortcut: Shortcut): string[] {
  if (IS_MAC) return shortcut.mac;
  return shortcut.other ?? shortcut.mac.map((key) => SYMBOL_TO_TEXT[key] ?? key);
}

const shortcutGroups: ShortcutGroup[] = [
  {
    title: "General",
    shortcuts: [
      { description: "New panel / launcher", mac: ["⌘", "T"] },
      { description: "Switch workspace", mac: ["⌘", "⇧", "O"] },
      { description: "Archive current panel", mac: ["⌘", "W"] },
      { description: "Keyboard shortcuts", mac: ["⌘", "/"] },
      { description: "Quit application", mac: ["⌘", "Q"] },
    ],
  },
  {
    title: "Navigation",
    shortcuts: [
      { description: "Back", mac: ["⌘", "["], other: ["Alt", "←"] },
      { description: "Forward", mac: ["⌘", "]"], other: ["Alt", "→"] },
      { description: "Reload panel", mac: ["⌘", "R"] },
      { description: "Force reload view", mac: ["⌘", "⇧", "R"] },
      { description: "Stop loading", mac: ["Esc"] },
      { description: "Toggle address bar", mac: ["⌘", "L"] },
    ],
  },
  {
    title: "View",
    shortcuts: [
      { description: "Zoom in", mac: ["⌘", "+"] },
      { description: "Zoom out", mac: ["⌘", "−"] },
      { description: "Reset zoom", mac: ["⌘", "0"] },
      { description: "Toggle fullscreen", mac: ["⌃", "⌘", "F"], other: ["F11"] },
      { description: "Minimize window", mac: ["⌘", "M"], platform: "mac" },
    ],
  },
  {
    title: "Editing",
    shortcuts: [
      { description: "Undo", mac: ["⌘", "Z"] },
      { description: "Redo", mac: ["⇧", "⌘", "Z"], other: ["Ctrl", "Y"] },
      { description: "Cut", mac: ["⌘", "X"] },
      { description: "Copy", mac: ["⌘", "C"] },
      { description: "Paste", mac: ["⌘", "V"] },
      { description: "Select all", mac: ["⌘", "A"] },
    ],
  },
  {
    title: "Developer",
    shortcuts: [
      { description: "Toggle panel DevTools", mac: ["⌘", "⇧", "I"] },
      { description: "Toggle app DevTools", mac: ["⌘", "⌥", "I"] },
    ],
  },
];

function ShortcutKeys({ shortcut }: { shortcut: Shortcut }) {
  const keys = keysFor(shortcut);
  if (IS_MAC) {
    // macOS convention: render the chord as one compact group, e.g. ⇧⌘O
    return <Kbd size="3">{keys.join("")}</Kbd>;
  }
  return (
    <Flex align="center" gap="1">
      {keys.map((key, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <Text size="1" color="gray">
              +
            </Text>
          )}
          <Kbd size="2">{key}</Kbd>
        </Fragment>
      ))}
    </Flex>
  );
}

function KeyboardShortcutsPage() {
  const currentPlatform = IS_MAC ? "mac" : "other";
  return (
    <AboutPage
      icon={<KeyboardIcon width={20} height={20} />}
      title="Keyboard Shortcuts"
      maxWidth={640}
    >
      {shortcutGroups.map((group) => {
        const visible = group.shortcuts.filter(
          (s) => !s.platform || s.platform === currentPlatform
        );
        if (visible.length === 0) return null;
        return (
          <Section key={group.title} title={group.title}>
            <Flex direction="column">
              {visible.map((shortcut, index) => (
                <Fragment key={shortcut.description}>
                  {index > 0 && <Separator size="4" my="2" />}
                  <Flex align="center" justify="between" gap="3">
                    <Text size="2">{shortcut.description}</Text>
                    <ShortcutKeys shortcut={shortcut} />
                  </Flex>
                </Fragment>
              ))}
            </Flex>
          </Section>
        );
      })}
    </AboutPage>
  );
}

mountAboutPanel(KeyboardShortcutsPage);
