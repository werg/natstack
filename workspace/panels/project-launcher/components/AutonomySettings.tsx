/**
 * Default autonomy level settings.
 */

import { Box, Text, SegmentedControl, Callout } from "@radix-ui/themes";
import { EyeOpenIcon, MixerHorizontalIcon, RocketIcon, InfoCircledIcon } from "@radix-ui/react-icons";

interface AutonomySettingsProps {
  autonomy: 0 | 1 | 2;
  onAutonomyChange: (autonomy: 0 | 1 | 2) => void;
}

const AUTONOMY_LABELS = {
  0: { label: "Manual", icon: EyeOpenIcon, description: "Agent asks for approval before taking actions" },
  1: { label: "Semi-Auto", icon: MixerHorizontalIcon, description: "Agent can take minor actions automatically" },
  2: { label: "Full Auto", icon: RocketIcon, description: "Agent operates with full autonomy" },
} as const;

export function AutonomySettings({ autonomy, onAutonomyChange }: AutonomySettingsProps) {
  const current = AUTONOMY_LABELS[autonomy];

  return (
    <Box>
      <Text as="label" size="2" weight="medium" mb="2" style={{ display: "block" }}>
        Default Autonomy Level
      </Text>

      <SegmentedControl.Root
        value={String(autonomy)}
        onValueChange={(value) => onAutonomyChange(Number(value) as 0 | 1 | 2)}
        style={{ width: "100%" }}
      >
        {([0, 1, 2] as const).map((level) => {
          const config = AUTONOMY_LABELS[level];
          const Icon = config.icon;
          return (
            <SegmentedControl.Item key={level} value={String(level)}>
              <Icon style={{ marginRight: 6 }} />
              {config.label}
            </SegmentedControl.Item>
          );
        })}
      </SegmentedControl.Root>

      <Box mt="3">
        <Callout.Root size="1" color="gray">
          <Callout.Icon>
            <InfoCircledIcon />
          </Callout.Icon>
          <Callout.Text>{current.description}</Callout.Text>
        </Callout.Root>
      </Box>
    </Box>
  );
}
