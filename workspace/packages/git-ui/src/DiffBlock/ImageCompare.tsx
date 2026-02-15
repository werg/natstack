import { useState } from "react";
import { Box, Flex, Text, Button, Card, Slider } from "@radix-ui/themes";

interface ImageCompareProps {
  oldDataUrl?: string;
  newDataUrl?: string;
  oldLabel?: string;
  newLabel?: string;
}

type CompareMode = "side" | "slider" | "onion";

export function ImageCompare({ oldDataUrl, newDataUrl, oldLabel = "Before", newLabel = "After" }: ImageCompareProps) {
  const [mode, setMode] = useState<CompareMode>("side");
  const [slider, setSlider] = useState([50]);
  const [opacity, setOpacity] = useState([50]);

  const hasBoth = Boolean(oldDataUrl && newDataUrl);

  if (!oldDataUrl && !newDataUrl) {
    return (
      <Card size="2">
        <Text size="2" color="gray">
          No preview available
        </Text>
      </Card>
    );
  }

  return (
    <Box>
      {hasBoth && (
        <Flex gap="2" mb="2" wrap="wrap">
          <Button size="1" variant={mode === "side" ? "soft" : "ghost"} onClick={() => setMode("side")}>Side</Button>
          <Button size="1" variant={mode === "slider" ? "soft" : "ghost"} onClick={() => setMode("slider")}>Slider</Button>
          <Button size="1" variant={mode === "onion" ? "soft" : "ghost"} onClick={() => setMode("onion")}>Onion</Button>
        </Flex>
      )}

      {mode === "side" && (
        <Card size="2">
          <Flex gap="3" wrap="wrap">
            {oldDataUrl && (
              <Box style={{ flex: 1, minWidth: 220 }}>
                <Text size="1" color="gray">{oldLabel}</Text>
                <Box mt="1" style={{ borderRadius: "var(--radius-2)", overflow: "hidden" }}>
                  <img src={oldDataUrl} alt={oldLabel} style={{ width: "100%", display: "block" }} />
                </Box>
              </Box>
            )}
            {newDataUrl && (
              <Box style={{ flex: 1, minWidth: 220 }}>
                <Text size="1" color="gray">{newLabel}</Text>
                <Box mt="1" style={{ borderRadius: "var(--radius-2)", overflow: "hidden" }}>
                  <img src={newDataUrl} alt={newLabel} style={{ width: "100%", display: "block" }} />
                </Box>
              </Box>
            )}
          </Flex>
        </Card>
      )}

      {mode === "slider" && oldDataUrl && newDataUrl && (
        <Card size="2">
          <Box style={{ position: "relative", width: "100%", overflow: "hidden", borderRadius: "var(--radius-2)" }}>
            <img src={oldDataUrl} alt={`${oldLabel} version (background)`} style={{ width: "100%", display: "block" }} />
            <Box
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: `${slider[0] ?? 50}%`,
                height: "100%",
                overflow: "hidden",
              }}
            >
              <img src={newDataUrl} alt={`${newLabel} version (overlay at ${slider[0] ?? 50}%)`} style={{ width: "100%", display: "block" }} />
            </Box>
          </Box>
          <Box mt="2">
            <Slider size="1" value={slider} onValueChange={setSlider} aria-label="Comparison slider" />
          </Box>
        </Card>
      )}

      {mode === "onion" && oldDataUrl && newDataUrl && (
        <Card size="2">
          <Box style={{ position: "relative", width: "100%", overflow: "hidden", borderRadius: "var(--radius-2)" }}>
            <img src={oldDataUrl} alt={`${oldLabel} version (background)`} style={{ width: "100%", display: "block" }} />
            <img
              src={newDataUrl}
              alt={`${newLabel} version (overlay at ${opacity[0] ?? 50}% opacity)`}
              style={{ width: "100%", display: "block", position: "absolute", top: 0, left: 0, opacity: (opacity[0] ?? 50) / 100 }}
            />
          </Box>
          <Box mt="2">
            <Slider size="1" value={opacity} onValueChange={setOpacity} aria-label="Opacity slider" />
          </Box>
        </Card>
      )}
    </Box>
  );
}
