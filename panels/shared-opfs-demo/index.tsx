import React, { useState, useEffect } from "react";
import { Theme, Button, Card, Flex, Text, Heading, Callout, Badge } from "@radix-ui/themes";
import panelAPI, { createReactPanelMount } from "natstack/react";
import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";

const mount = createReactPanelMount(React, createRoot, { ThemeComponent: Theme });

function SharedOPFSPanel() {
  const [opfsStatus, setOpfsStatus] = useState<string>("");
  const [opfsContent, setOpfsContent] = useState<string>("");
  const [theme, setTheme] = useState(panelAPI.getTheme().appearance);
  const [partition, setPartition] = useState<string | undefined>(undefined);

  useEffect(() => {
    return panelAPI.onThemeChange(({ appearance }) => setTheme(appearance));
  }, []);

  useEffect(() => {
    panelAPI.getPartition().then(setPartition).catch(console.error);
  }, []);

  const writeSharedFile = async () => {
    try {
      setOpfsStatus("Writing to shared OPFS...");

      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle("example.txt", { create: true });
      const writable = await fileHandle.createWritable();

      const timestamp = new Date().toISOString();
      const content = `Shared file updated!\nTime: ${timestamp}\nFrom Panel: ${panelAPI.getId()}`;
      await writable.write(content);
      await writable.close();

      setOpfsStatus("Successfully wrote to shared OPFS!");
      setOpfsContent("");
    } catch (error) {
      setOpfsStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const readSharedFile = async () => {
    try {
      setOpfsStatus("Reading from shared OPFS...");

      const root = await navigator.storage.getDirectory();
      const fileHandle = await root.getFileHandle("example.txt");
      const file = await fileHandle.getFile();
      const text = await file.text();

      setOpfsContent(text);
      setOpfsStatus("Successfully read from shared OPFS!");
    } catch (error) {
      if (error instanceof Error && error.name === "NotFoundError") {
        setOpfsStatus("Shared file not found. Write to it first!");
        setOpfsContent("");
      } else {
        setOpfsStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
        setOpfsContent("");
      }
    }
  };

  const listSharedFiles = async () => {
    try {
      setOpfsStatus("Listing shared OPFS files...");

      const root = await navigator.storage.getDirectory();
      const files: string[] = [];

      // @ts-ignore
      for await (const entry of root.values()) {
        files.push(`${entry.name} (${entry.kind})`);
      }

      if (files.length === 0) {
        setOpfsStatus("Shared OPFS is empty");
        setOpfsContent("");
      } else {
        setOpfsStatus(`Found ${files.length} item(s) in shared OPFS`);
        setOpfsContent(files.join("\n"));
      }
    } catch (error) {
      setOpfsStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const launchAnotherSharedPanel = async () => {
    try {
      const childId = await panelAPI.createChild("panels/shared-opfs-demo", {
        PARENT_ID: panelAPI.getId(),
      });
      setOpfsStatus(`Launched sibling panel ${childId} - it shares the same OPFS!`);
    } catch (error) {
      setOpfsStatus(`Failed to launch: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <Card size="3" style={{ width: "100%" }}>
      <Flex direction="column" gap="4">
        <Flex align="center" gap="3">
          <Heading size="6">Shared OPFS Demo</Heading>
          <Badge color="purple">Shared Partition</Badge>
        </Flex>

        <Text size="2" color="gray">
          This panel uses a shared partition. All panels with the same partition share the same OPFS context!
        </Text>

        <Card variant="surface">
          <Flex direction="column" gap="2">
            <Text size="2" weight="bold">Panel Info:</Text>
            <Text size="1" style={{ fontFamily: "monospace" }}>
              ID: {panelAPI.getId()}
            </Text>
            <Text size="1" style={{ fontFamily: "monospace" }}>
              Partition: {partition || '(loading...)'}
            </Text>
            <Text size="1" style={{ fontFamily: "monospace" }}>
              Theme: {theme}
            </Text>
          </Flex>
        </Card>

        <Flex gap="2" wrap="wrap">
          <Button onClick={writeSharedFile} variant="soft" color="green">
            Write Shared File
          </Button>
          <Button onClick={readSharedFile} variant="soft" color="blue">
            Read Shared File
          </Button>
          <Button onClick={listSharedFiles} variant="soft" color="purple">
            List Shared Files
          </Button>
        </Flex>

        <Button onClick={launchAnotherSharedPanel} variant="outline">
          Launch Another Shared Panel
        </Button>

        {opfsStatus && (
          <Callout.Root color={opfsStatus.includes("Error") || opfsStatus.includes("not found") ? "red" : "green"}>
            <Callout.Text>{opfsStatus}</Callout.Text>
          </Callout.Root>
        )}

        {opfsContent && (
          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">Content:</Text>
              <Text size="1" style={{ fontFamily: "monospace", whiteSpace: "pre-wrap" }}>
                {opfsContent}
              </Text>
            </Flex>
          </Card>
        )}
      </Flex>
    </Card>
  );
}

mount(SharedOPFSPanel);
