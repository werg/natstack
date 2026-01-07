import { Box, Flex, Text, Button, TextField } from "@radix-ui/themes";
import type { DiffViewOptions } from "./types";

interface DiffViewControlsProps {
  options: DiffViewOptions;
  onChange: (next: DiffViewOptions) => void;
}

export function DiffViewControls({ options, onChange }: DiffViewControlsProps) {
  return (
    <Flex align="center" gap="3" px="3" py="2" wrap="wrap">
      <Flex align="center" gap="1" role="group" aria-label="View mode">
        <Button
          size="1"
          variant={options.viewMode === "split" ? "soft" : "ghost"}
          onClick={() => onChange({ ...options, viewMode: "split" })}
          aria-pressed={options.viewMode === "split"}
          aria-label="Split view"
        >
          Split
        </Button>
        <Button
          size="1"
          variant={options.viewMode === "unified" ? "soft" : "ghost"}
          onClick={() => onChange({ ...options, viewMode: "unified" })}
          aria-pressed={options.viewMode === "unified"}
          aria-label="Unified view"
        >
          Unified
        </Button>
      </Flex>

      <Flex align="center" gap="1" role="group" aria-label="Diff options">
        <Button
          size="1"
          variant={options.wordDiff ? "soft" : "ghost"}
          onClick={() => onChange({ ...options, wordDiff: !options.wordDiff })}
          aria-pressed={options.wordDiff}
          aria-label="Word-level diff"
        >
          Word
        </Button>
        <Button
          size="1"
          variant={options.showWhitespace ? "soft" : "ghost"}
          onClick={() => onChange({ ...options, showWhitespace: !options.showWhitespace })}
          aria-pressed={options.showWhitespace}
          aria-label="Show whitespace"
        >
          WS
        </Button>
      </Flex>

      <Flex align="center" gap="2">
        <Text size="1" color="gray">
          Context
        </Text>
        <Box width="48px">
          <TextField.Root
            size="1"
            type="number"
            min={0}
            max={20}
            value={options.contextLines}
            onChange={(e) => {
              const value = Number(e.target.value);
              const clamped = Number.isFinite(value) ? Math.max(0, Math.min(20, value)) : 3;
              onChange({ ...options, contextLines: clamped });
            }}
          />
        </Box>
      </Flex>
    </Flex>
  );
}
