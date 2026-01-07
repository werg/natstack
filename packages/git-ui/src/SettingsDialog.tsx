import { Button, Dialog, Flex, Text, Switch, SegmentedControl, TextField, Separator, Kbd } from "@radix-ui/themes";
import { KEYBOARD_SHORTCUTS } from "./constants";
import type { DiffViewOptions } from "./DiffBlock";

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  diffViewOptions: DiffViewOptions;
  onDiffViewOptionsChange: (options: DiffViewOptions) => void;
}

export function SettingsDialog({
  open,
  onOpenChange,
  diffViewOptions,
  onDiffViewOptionsChange,
}: SettingsDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Content maxWidth="400px">
        <Dialog.Title>Settings</Dialog.Title>

        <Flex direction="column" gap="4" mt="3">
          {/* Diff View Options Section */}
          <Flex direction="column" gap="3">
            <Text size="2" weight="medium">Diff View Options</Text>

            {/* View Mode */}
            <Flex align="center" justify="between">
              <Flex direction="column" gap="1">
                <Text size="2">View Mode</Text>
                <Text size="1" color="gray">
                  Display diffs side-by-side or unified
                </Text>
              </Flex>
              <SegmentedControl.Root
                size="1"
                value={diffViewOptions.viewMode}
                onValueChange={(value: "split" | "unified") =>
                  onDiffViewOptionsChange({ ...diffViewOptions, viewMode: value })
                }
              >
                <SegmentedControl.Item value="split">Split</SegmentedControl.Item>
                <SegmentedControl.Item value="unified">Unified</SegmentedControl.Item>
              </SegmentedControl.Root>
            </Flex>

            {/* Word Diff */}
            <Flex align="center" justify="between">
              <Flex direction="column" gap="1">
                <Text size="2">Word-Level Diff</Text>
                <Text size="1" color="gray">
                  Highlight changes at word level, not just lines
                </Text>
              </Flex>
              <Switch
                size="1"
                checked={diffViewOptions.wordDiff}
                onCheckedChange={(checked) =>
                  onDiffViewOptionsChange({ ...diffViewOptions, wordDiff: checked })
                }
              />
            </Flex>

            {/* Show Whitespace */}
            <Flex align="center" justify="between">
              <Flex direction="column" gap="1">
                <Text size="2">Show Whitespace</Text>
                <Text size="1" color="gray">
                  Display spaces and tabs as visible characters
                </Text>
              </Flex>
              <Switch
                size="1"
                checked={diffViewOptions.showWhitespace}
                onCheckedChange={(checked) =>
                  onDiffViewOptionsChange({ ...diffViewOptions, showWhitespace: checked })
                }
              />
            </Flex>

            {/* Context Lines */}
            <Flex align="center" justify="between">
              <Flex direction="column" gap="1">
                <Text size="2">Context Lines</Text>
                <Text size="1" color="gray">
                  Lines of unchanged code around changes
                </Text>
              </Flex>
              <TextField.Root
                size="1"
                type="number"
                min={0}
                max={20}
                value={diffViewOptions.contextLines}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  const clamped = Number.isFinite(value) ? Math.max(0, Math.min(20, value)) : 3;
                  onDiffViewOptionsChange({ ...diffViewOptions, contextLines: clamped });
                }}
                style={{ width: 56 }}
              />
            </Flex>
          </Flex>

          <Separator size="4" />

          {/* Keyboard Shortcuts Section */}
          <Flex direction="column" gap="2">
            <Text size="2" weight="medium">Keyboard Shortcuts</Text>

            {KEYBOARD_SHORTCUTS.map(({ key, description }) => (
              <Flex key={key} align="center" justify="between" py="1">
                <Text size="1" color="gray">
                  {description}
                </Text>
                <Kbd size="1">{key}</Kbd>
              </Flex>
            ))}
          </Flex>
        </Flex>

        <Flex mt="4" justify="end">
          <Dialog.Close>
            <Button size="2">Done</Button>
          </Dialog.Close>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
