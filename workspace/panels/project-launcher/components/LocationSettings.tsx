/**
 * Project location mode selector.
 * Allows choosing between "Managed Workspace" and "External Folder" modes.
 */

import { Box, Text, SegmentedControl, Callout } from "@radix-ui/themes";
import { LaptopIcon, GlobeIcon, InfoCircledIcon } from "@radix-ui/react-icons";

interface LocationSettingsProps {
  location: "managed" | "external";
  onLocationChange: (location: "managed" | "external") => void;
}

export function LocationSettings({ location, onLocationChange }: LocationSettingsProps) {
  return (
    <Box>
      <Text as="label" size="2" weight="medium" mb="2" style={{ display: "block" }}>
        Project Location
      </Text>

      <SegmentedControl.Root
        value={location}
        onValueChange={(value) => onLocationChange(value as "managed" | "external")}
        style={{ width: "100%" }}
      >
        <SegmentedControl.Item value="external">
          <LaptopIcon style={{ marginRight: 6 }} />
          External Folder
        </SegmentedControl.Item>
        <SegmentedControl.Item value="managed">
          <GlobeIcon style={{ marginRight: 6 }} />
          Managed Workspace
        </SegmentedControl.Item>
      </SegmentedControl.Root>

      <Box mt="3">
        {location === "external" ? (
          <Callout.Root size="1" color="gray">
            <Callout.Icon>
              <InfoCircledIcon />
            </Callout.Icon>
            <Callout.Text>
              Work with files on your local filesystem. The agent will have direct access to read
              and modify files in the selected folder.
            </Callout.Text>
          </Callout.Root>
        ) : (
          <Callout.Root size="1" color="blue">
            <Callout.Icon>
              <InfoCircledIcon />
            </Callout.Icon>
            <Callout.Text>
              Work in a sandboxed environment. Files are stored in the browser and synced with
              selected workspace repositories.
            </Callout.Text>
          </Callout.Root>
        )}
      </Box>
    </Box>
  );
}
