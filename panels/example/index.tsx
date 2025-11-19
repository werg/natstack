import React, { useState, useEffect } from "react";
import { Theme, Button, Card, Flex, Text, Heading, Callout } from "@radix-ui/themes";
import panelAPI, { createReactPanelMount } from "natstack/react";
import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import "./style.css";

const mount = createReactPanelMount(React, createRoot, { ThemeComponent: Theme });

function ChildPanelLauncher() {
  const [status, setStatus] = useState<string>("");
  const [theme, setTheme] = useState(panelAPI.getTheme().appearance);

  useEffect(() => panelAPI.onThemeChange(({ appearance }) => setTheme(appearance)), []);

  const launchChild = async () => {
    try {
      setStatus("Launching child panel...");
      const childId = await panelAPI.createChild("panels/example");
      setStatus(`Launched child ${childId}`);
    } catch (error) {
      setStatus(`Failed to launch child: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const setRandomTitle = async () => {
    const title = `Radix Panel ${Math.floor(Math.random() * 1000)}`;
    await panelAPI.setTitle(title);
    setStatus(`Title set to ${title}`);
  };

  return (
    <Card size="3" style={{ width: "100%" }}>
      <Flex direction="column" gap="4">
        <Heading size="6">React + Radix Panel</Heading>
        <Text size="2">
          Current theme: <Text weight="bold">{theme}</Text>
        </Text>
        <Flex gap="3">
          <Button onClick={launchChild}>Launch child panel</Button>
          <Button variant="soft" onClick={setRandomTitle}>
            Set random title
          </Button>
        </Flex>
        {status && (
          <Callout.Root color="blue">
            <Callout.Text>{status}</Callout.Text>
          </Callout.Root>
        )}
      </Flex>
    </Card>
  );
}

mount(ChildPanelLauncher);
