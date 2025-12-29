import { useState } from "react";
import { promises as fsPromises } from "fs";
import { Button, Card, Flex, Text, Heading, Callout, Badge } from "@radix-ui/themes";
import { createChild } from "@natstack/runtime";
import { usePanelTheme, usePanelId, usePanelPartition } from "@natstack/react";

export default function SharedOPFSPanel() {
  const [opfsStatus, setOpfsStatus] = useState<string>("");
  const [opfsContent, setOpfsContent] = useState<string>("");
  const theme = usePanelTheme();
  const panelId = usePanelId();
  const partition = usePanelPartition();
  const sharedFilePath = "/example.txt";

  const writeSharedFile = async () => {
    try {
      setOpfsStatus("Writing to shared OPFS...");

      const timestamp = new Date().toISOString();
      const content = `Shared file updated!\nTime: ${timestamp}\nFrom Panel: ${panelId}`;
      await fsPromises.writeFile(sharedFilePath, content, "utf-8");

      setOpfsStatus("Successfully wrote to shared OPFS!");
      setOpfsContent("");
    } catch (error) {
      setOpfsStatus(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const readSharedFile = async () => {
    try {
      setOpfsStatus("Reading from shared OPFS...");

      const text = await fsPromises.readFile(sharedFilePath, "utf-8");

      setOpfsContent(text);
      setOpfsStatus("Successfully read from shared OPFS!");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
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

      const files = await fsPromises.readdir("/");

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
      const child = await createChild("panels/shared-opfs-demo", { env: { PARENT_ID: panelId } });
      setOpfsStatus(`Launched sibling panel ${child.name} (${child.id}) - it shares the same OPFS!`);
    } catch (error) {
      setOpfsStatus(`Failed to launch: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div style={{ padding: "20px" }}>
      <Card size="3" style={{ width: "100%" }}>
        <Flex direction="column" gap="4">
          <Flex align="center" gap="3">
            <Heading size="6">Shared OPFS Demo</Heading>
            <Badge color="purple">Singleton Partition</Badge>
          </Flex>

          <Text size="2" color="gray">
            This panel uses a singleton partition id so every launch reuses the same OPFS context.
          </Text>

          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">Panel Info:</Text>
              <Text size="1" style={{ fontFamily: "monospace" }}>
                ID: {panelId}
              </Text>
              <Text size="1" style={{ fontFamily: "monospace" }}>
                Partition: {partition ?? "(loading...)"}
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
    </div>
  );
}
