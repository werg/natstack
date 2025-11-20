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

  useEffect(() => {
    return panelAPI.onThemeChange(({ appearance }) => setTheme(appearance));
  }, []);

  // Get env variables that were passed from parent
  const parentId = process.env.PARENT_ID;
  const launchTime = process.env.LAUNCH_TIME;
  const message = process.env.MESSAGE;

  const launchChild = async () => {
    try {
      setStatus("Launching child panel...");
      const childEnv = {
        PARENT_ID: panelAPI.getId(),
        LAUNCH_TIME: new Date().toISOString(),
        MESSAGE: "Hello from parent panel!",
      };
      const childId = await panelAPI.createChild("panels/example", childEnv);
      setStatus(`Launched child ${childId} with env variables`);
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
        <Text size="2">
          Panel ID: <Text weight="bold">{panelAPI.getId()}</Text>
        </Text>
        {(parentId || launchTime || message) && (
          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">
                Environment Variables (from process.env):
              </Text>
              {parentId && (
                <Text size="1" style={{ fontFamily: "monospace" }}>
                  PARENT_ID: {parentId}
                </Text>
              )}
              {launchTime && (
                <Text size="1" style={{ fontFamily: "monospace" }}>
                  LAUNCH_TIME: {launchTime}
                </Text>
              )}
              {message && (
                <Text size="1" style={{ fontFamily: "monospace" }}>
                  MESSAGE: {message}
                </Text>
              )}
            </Flex>
          </Card>
        )}
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
