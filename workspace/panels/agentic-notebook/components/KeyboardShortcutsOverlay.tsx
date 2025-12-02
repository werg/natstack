import { useEffect } from "react";
import { useAtom, useAtomValue } from "jotai";
import { Box, Flex, Text, Kbd, Dialog, Button } from "@radix-ui/themes";
import { Cross2Icon, KeyboardIcon } from "@radix-ui/react-icons";
import { shortcutsOverlayOpenAtom, submitKeyConfigAtom } from "../state/uiAtoms";

interface ShortcutItemProps {
  keys: string[];
  description: string;
}

/**
 * Individual shortcut item display.
 */
function ShortcutItem({ keys, description }: ShortcutItemProps) {
  return (
    <Flex justify="between" align="center" py="2">
      <Text size="2">{description}</Text>
      <Flex gap="1">
        {keys.map((key, i) => (
          <Kbd key={i}>{key}</Kbd>
        ))}
      </Flex>
    </Flex>
  );
}

/**
 * Section header for grouping shortcuts.
 */
function ShortcutSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box mb="4">
      <Text size="2" weight="bold" color="gray" mb="2" style={{ display: "block" }}>
        {title}
      </Text>
      <Box style={{ borderTop: "1px solid var(--gray-a5)" }}>
        {children}
      </Box>
    </Box>
  );
}

/**
 * Detect if user is on macOS.
 */
function isMac(): boolean {
  return typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");
}

/**
 * Get the appropriate modifier key name.
 */
function getModKey(): string {
  return isMac() ? "Cmd" : "Ctrl";
}

/**
 * KeyboardShortcutsOverlay - Modal showing all keyboard shortcuts.
 */
export function KeyboardShortcutsOverlay() {
  const [isOpen, setIsOpen] = useAtom(shortcutsOverlayOpenAtom);
  const submitKeyConfig = useAtomValue(submitKeyConfigAtom);

  // Listen for ? key to open overlay
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Open on ? (Shift+/) when not in an input
      if (
        event.key === "?" &&
        !["INPUT", "TEXTAREA"].includes((event.target as HTMLElement).tagName)
      ) {
        event.preventDefault();
        setIsOpen(true);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [setIsOpen]);

  const modKey = getModKey();

  return (
    <Dialog.Root open={isOpen} onOpenChange={setIsOpen}>
      <Dialog.Content maxWidth="450px">
        <Flex justify="between" align="center" mb="4">
          <Flex align="center" gap="2">
            <KeyboardIcon width="20" height="20" />
            <Dialog.Title mb="0">Keyboard Shortcuts</Dialog.Title>
          </Flex>
          <Dialog.Close>
            <Button variant="ghost" color="gray" size="1">
              <Cross2Icon />
            </Button>
          </Dialog.Close>
        </Flex>

        <ShortcutSection title="General">
          <ShortcutItem keys={["?"]} description="Show keyboard shortcuts" />
          <ShortcutItem keys={["Esc"]} description="Stop generation / Close dialog" />
          <ShortcutItem keys={[modKey, "N"]} description="New chat" />
          <ShortcutItem keys={[modKey, "B"]} description="Toggle sidebar" />
        </ShortcutSection>

        <ShortcutSection title="Input">
          <ShortcutItem
            keys={submitKeyConfig.submitKey.split("+")}
            description="Send message / Run code"
          />
          <ShortcutItem
            keys={submitKeyConfig.submitKey === "Enter" ? ["Shift", "Enter"] : ["Enter"]}
            description="New line"
          />
        </ShortcutSection>

        <ShortcutSection title="Navigation">
          <ShortcutItem keys={[modKey, "K"]} description="Search chats" />
        </ShortcutSection>

        <Box mt="4" pt="3" style={{ borderTop: "1px solid var(--gray-a5)" }}>
          <Text size="1" color="gray">
            Press <Kbd>?</Kbd> anytime to show this overlay
          </Text>
        </Box>
      </Dialog.Content>
    </Dialog.Root>
  );
}
