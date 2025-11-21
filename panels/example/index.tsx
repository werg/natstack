import React, { useState, useEffect } from "react";
import fs, { promises as fsPromises } from "fs";
import { Theme, Button, Card, Flex, Text, Heading, Callout, Separator, Badge } from "@radix-ui/themes";
import panelAPI, { createReactPanelMount } from "natstack/react";
import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import "./style.css";

const mount = createReactPanelMount(React, createRoot, { ThemeComponent: Theme });

function ChildPanelLauncher() {
  const [status, setStatus] = useState<string>("");
  const [theme, setTheme] = useState(panelAPI.getTheme().appearance);
  const [opfsStatus, setOpfsStatus] = useState<string>("");
  const [opfsContent, setOpfsContent] = useState<string>("");
  const [partition, setPartition] = useState<string | undefined>(undefined);

  useEffect(() => {
    return panelAPI.onThemeChange(({ appearance }) => setTheme(appearance));
  }, []);

  useEffect(() => {
    panelAPI.getPartition().then(setPartition).catch(console.error);
  }, []);

  // Get env variables that were passed from parent
  const parentId = process.env.PARENT_ID;
  const launchTime = process.env.LAUNCH_TIME;
  const message = process.env.MESSAGE;

  const launchChild = async () => {
    try {
      setStatus("Launching child panel...");
      const childId = await panelAPI.createChild("panels/example", {
        env: {
          PARENT_ID: panelAPI.getId(),
          LAUNCH_TIME: new Date().toISOString(),
          MESSAGE: "Hello from parent panel!",
        }
      });
      setStatus(`Launched child ${childId} with isolated OPFS`);
    } catch (error) {
      setStatus(`Failed to launch child: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const launchSharedOPFSDemo = async () => {
    try {
      setStatus("Launching shared OPFS demo panel...");
      const childId = await panelAPI.createChild("panels/shared-opfs-demo", {
        partition: "shared-storage"
      });
      setStatus(`Launched shared OPFS demo panel ${childId} (partition: shared-storage)`);
    } catch (error) {
      setStatus(`Failed to launch: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const launchExampleWithSharedPartition = async () => {
    try {
      setStatus("Launching example panel with shared partition...");
      const childId = await panelAPI.createChild("panels/example", {
        env: {
          PARENT_ID: panelAPI.getId(),
          LAUNCH_TIME: new Date().toISOString(),
          MESSAGE: "I share OPFS with siblings!",
        },
        partition: "shared-storage"
      });
      setStatus(`Launched example panel ${childId} with shared partition!`);
    } catch (error) {
      setStatus(`Failed to launch: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const setRandomTitle = async () => {
    const title = `Radix Panel ${Math.floor(Math.random() * 1000)}`;
    await panelAPI.setTitle(title);
    setStatus(`Title set to ${title}`);
  };

  const exampleFilePath = "/example.txt";

  // OPFS (Origin Private File System) example functions via fs (ZenFS WebAccess backend)
  const writeToOPFS = async () => {
    try {
      setOpfsStatus("Writing to OPFS...");

      const timestamp = new Date().toISOString();
      const content = `Hello from NatStack panel!\nWritten at: ${timestamp}\nPanel ID: ${panelAPI.getId()}`;
      await fsPromises.writeFile(exampleFilePath, content, "utf-8");

      setOpfsStatus("Successfully wrote to OPFS file: example.txt");
      setOpfsContent("");
    } catch (error) {
      setOpfsStatus(`Error writing to OPFS: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const readFromOPFS = async () => {
    try {
      setOpfsStatus("Reading from OPFS...");

      const text = await fsPromises.readFile(exampleFilePath, "utf-8");

      setOpfsContent(text);
      setOpfsStatus("Successfully read from OPFS file: example.txt");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        setOpfsStatus("File not found. Write to OPFS first!");
        setOpfsContent("");
      } else {
        setOpfsStatus(`Error reading from OPFS: ${error instanceof Error ? error.message : String(error)}`);
        setOpfsContent("");
      }
    }
  };

  const deleteFromOPFS = async () => {
    try {
      setOpfsStatus("Deleting from OPFS...");

      await fsPromises.rm(exampleFilePath);

      setOpfsStatus("Successfully deleted example.txt from OPFS");
      setOpfsContent("");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        setOpfsStatus("File not found. Nothing to delete!");
      } else {
        setOpfsStatus(`Error deleting from OPFS: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const listOPFSFiles = async () => {
    try {
      setOpfsStatus("Listing OPFS files...");

      const files = await fsPromises.readdir("/");

      if (files.length === 0) {
        setOpfsStatus("OPFS is empty");
        setOpfsContent("");
      } else {
        setOpfsStatus(`Found ${files.length} item(s) in OPFS`);
        setOpfsContent(files.join("\n"));
      }
    } catch (error) {
      setOpfsStatus(`Error listing OPFS: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <Card size="3" style={{ width: "100%" }}>
      <Flex direction="column" gap="4">
        <Flex align="center" gap="3">
          <Heading size="6">React + Radix Panel</Heading>
          {partition ? (
            <Badge color="orange">Shared: {partition}</Badge>
          ) : (
            <Badge color="blue">Isolated OPFS</Badge>
          )}
        </Flex>
        <Text size="2">
          Current theme: <Text weight="bold">{theme}</Text>
        </Text>
        <Text size="2">
          Panel ID: <Text weight="bold">{panelAPI.getId()}</Text>
        </Text>
        <Text size="2">
          Partition: <Text weight="bold" style={{ fontFamily: "monospace" }}>
            {partition || `panel-${panelAPI.getId()} (isolated)`}
          </Text>
        </Text>
        <Card variant="surface">
          <Flex direction="column" gap="2">
            <Text size="2" weight="bold">Partition Configuration:</Text>
            <Text size="1" color="gray">
              • <Text weight="bold">Isolated (default):</Text> Each panel instance gets its own OPFS partition
            </Text>
            <Text size="1" color="gray">
              • <Text weight="bold">Shared (runtime override):</Text> Multiple panels can share the same OPFS by specifying a partition name
            </Text>
            <Text size="1" color="gray">
              • <Text weight="bold">Manifest partition:</Text> Panels can define a default partition in panel.json
            </Text>
          </Flex>
        </Card>
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
        <Flex gap="3" wrap="wrap">
          <Button onClick={launchChild}>Launch child panel (isolated)</Button>
          <Button onClick={launchExampleWithSharedPartition} color="orange">
            Launch child (shared partition)
          </Button>
          <Button onClick={launchSharedOPFSDemo} color="purple">
            Launch Shared OPFS Demo
          </Button>
          <Button variant="soft" onClick={setRandomTitle}>
            Set random title
          </Button>
        </Flex>
        {status && (
          <Callout.Root color="blue">
            <Callout.Text>{status}</Callout.Text>
          </Callout.Root>
        )}

        <Separator size="4" />

        {/* OPFS Demo Section */}
        <Heading size="5">OPFS Demo</Heading>
        <Text size="2" color="gray">
          This panel writes to "example.txt". If launched with isolated partition (default), each instance has separate storage. If launched with shared partition, all instances with the same partition share files.
        </Text>
        {message && message.includes("share OPFS") && (
          <Callout.Root color="orange">
            <Callout.Text>
              This instance is using the SHARED partition! Files here are accessible to other panels with partition "shared-storage".
            </Callout.Text>
          </Callout.Root>
        )}

        <Flex gap="2" wrap="wrap">
          <Button onClick={writeToOPFS} variant="soft" color="green">
            Write to OPFS
          </Button>
          <Button onClick={readFromOPFS} variant="soft" color="blue">
            Read from OPFS
          </Button>
          <Button onClick={listOPFSFiles} variant="soft" color="purple">
            List OPFS Files
          </Button>
          <Button onClick={deleteFromOPFS} variant="soft" color="red">
            Delete from OPFS
          </Button>
        </Flex>

        {opfsStatus && (
          <Callout.Root color={opfsStatus.includes("Error") || opfsStatus.includes("not found") ? "red" : "green"}>
            <Callout.Text>{opfsStatus}</Callout.Text>
          </Callout.Root>
        )}

        {opfsContent && (
          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">
                File Content / List:
              </Text>
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

mount(ChildPanelLauncher);
