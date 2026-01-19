/**
 * Context Demo Panel
 *
 * Demonstrates NatStack context features:
 * - Auto contexts (named vs unnamed children)
 * - Shared contexts using contextId
 * - Isolated contexts using newContext: true
 * - Context utility functions
 */

import { useState, useEffect } from "react";
import { promises as fsPromises } from "fs";
import { Button, Card, Flex, Text, Heading, Callout, Separator, Badge, Code, TextField } from "@radix-ui/themes";
import {
  createChild,
  contextId,
  parseContextId,
  isSafeContext,
  isUnsafeContext,
  isAutoContext,
  isNamedContext,
  type ChildHandle,
} from "@natstack/runtime";
import { useContextId, usePanelId, usePanelPartition } from "@natstack/react";

export default function ContextDemo() {
  const panelId = usePanelId();
  const currentContextId = useContextId();
  const partition = usePanelPartition();

  const [children, setChildren] = useState<ChildHandle[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [fileContent, setFileContent] = useState<string>("");
  const [customContextId, setCustomContextId] = useState("safe_named_shared-workspace");
  const [filePath, setFilePath] = useState("/context-demo/test.txt");
  const [fileInput, setFileInput] = useState("Hello from OPFS!");
  const [directoryListing, setDirectoryListing] = useState<string[]>([]);

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLog((prev) => [`[${timestamp}] ${message}`, ...prev.slice(0, 19)]);
  };

  // Parse the current context ID to show its components
  const parsed = parseContextId(currentContextId);

  // Get directory from file path
  const getDirectory = (path: string) => {
    const lastSlash = path.lastIndexOf("/");
    return lastSlash > 0 ? path.slice(0, lastSlash) : "/";
  };

  // Write a file to demonstrate context-scoped storage
  const writeToStorage = async () => {
    try {
      const dir = getDirectory(filePath);
      await fsPromises.mkdir(dir, { recursive: true });
      await fsPromises.writeFile(filePath, fileInput);
      addLog(`Wrote ${fileInput.length} bytes to ${filePath}`);
      setFileContent(fileInput);
    } catch (error) {
      addLog(`Write error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Read the file to demonstrate context-scoped storage
  const readFromStorage = async () => {
    try {
      const content = await fsPromises.readFile(filePath, "utf-8");
      addLog(`Read ${content.length} bytes from ${filePath}`);
      setFileContent(content);
    } catch (error) {
      addLog(`Read error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Delete a file
  const deleteFile = async () => {
    try {
      await fsPromises.unlink(filePath);
      addLog(`Deleted ${filePath}`);
      setFileContent("");
    } catch (error) {
      addLog(`Delete error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // List directory contents
  const listDirectory = async () => {
    const dir = getDirectory(filePath);
    try {
      const entries = await fsPromises.readdir(dir);
      setDirectoryListing(entries);
      addLog(`Listed ${entries.length} entries in ${dir}`);
    } catch (error) {
      addLog(`List error: ${error instanceof Error ? error.message : String(error)}`);
      setDirectoryListing([]);
    }
  };

  // Get file stats
  const getFileStats = async () => {
    try {
      const stats = await fsPromises.stat(filePath);
      addLog(`Stats for ${filePath}: size=${stats.size}, isFile=${stats.isFile()}, isDir=${stats.isDirectory()}`);
    } catch (error) {
      addLog(`Stats error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Launch a named child (deterministic, resumable context)
  const launchNamedChild = async () => {
    try {
      const child = await createChild("panels/session-demo", { name: "named-child" });
      addLog(`Launched named child: ${child.id} (context: auto-derived, resumable)`);
      setChildren((prev) => [...prev, child]);
    } catch (error) {
      addLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Launch an unnamed child (random nonce, non-resumable context)
  const launchUnnamedChild = async () => {
    try {
      const child = await createChild("panels/session-demo");
      addLog(`Launched unnamed child: ${child.id} (context: random nonce, NOT resumable)`);
      setChildren((prev) => [...prev, child]);
    } catch (error) {
      addLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Launch a child with explicit shared context
  const launchSharedContextChild = async () => {
    try {
      const child = await createChild("panels/session-demo", {
        name: "shared-context-child",
        contextId: customContextId,
      });
      addLog(`Launched shared context child: ${child.id} (context: ${customContextId})`);
      setChildren((prev) => [...prev, child]);
    } catch (error) {
      addLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Launch a child with isolated context (newContext: true)
  const launchIsolatedChild = async () => {
    try {
      const child = await createChild("panels/session-demo", {
        name: "isolated-child",
        newContext: true,
      });
      addLog(`Launched isolated child: ${child.id} (context: new random, isolated)`);
      setChildren((prev) => [...prev, child]);
    } catch (error) {
      addLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Close a child
  const closeChild = async (child: ChildHandle) => {
    try {
      await child.close();
      setChildren((prev) => prev.filter((c) => c.id !== child.id));
      addLog(`Closed child: ${child.id}`);
    } catch (error) {
      addLog(`Error closing: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <Flex direction="column" gap="4" p="4" style={{ maxWidth: 900 }}>
      <Heading size="6">Context Demo</Heading>
      <Text size="2" color="gray">
        Demonstrates NatStack context-based storage partitioning. Panels with the same context share OPFS storage.
      </Text>

      <Separator size="4" />

      {/* Current Context Info */}
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="4">Current Context Info</Heading>

          <Flex direction="column" gap="1">
            <Text size="2">
              <Text weight="bold">Panel ID:</Text>{" "}
              <Code>{panelId}</Code>
            </Text>
            <Text size="2">
              <Text weight="bold">Context ID:</Text>{" "}
              <Code>{currentContextId}</Code>
            </Text>
            <Text size="2">
              <Text weight="bold">Partition:</Text>{" "}
              <Code>{partition ?? "loading..."}</Code>
            </Text>
          </Flex>

          {parsed && (
            <Card variant="surface">
              <Flex direction="column" gap="1">
                <Text size="2" weight="bold">Parsed Context Components:</Text>
                <Flex gap="2" wrap="wrap">
                  <Badge color={parsed.mode === "safe" ? "green" : "red"}>
                    Mode: {parsed.mode}
                  </Badge>
                  <Badge color={parsed.type === "auto" ? "blue" : "purple"}>
                    Type: {parsed.type}
                  </Badge>
                  <Badge color="gray">
                    ID: {parsed.identifier}
                  </Badge>
                </Flex>
                <Text size="1" color="gray" style={{ marginTop: 8 }}>
                  Utility checks: isSafe={String(isSafeContext(currentContextId))},
                  isUnsafe={String(isUnsafeContext(currentContextId))},
                  isAuto={String(isAutoContext(currentContextId))},
                  isNamed={String(isNamedContext(currentContextId))}
                </Text>
              </Flex>
            </Card>
          )}
        </Flex>
      </Card>

      <Separator size="4" />

      {/* Context-Scoped Storage Demo */}
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="4">Context-Scoped Storage (OPFS)</Heading>
          <Text size="2" color="gray">
            Files written here are scoped to this context. Panels sharing the same context can read/write the same files.
          </Text>

          <Flex direction="column" gap="2">
            <Text size="2" weight="bold">File Path:</Text>
            <TextField.Root
              placeholder="/path/to/file.txt"
              value={filePath}
              onChange={(e) => setFilePath(e.target.value)}
              size="2"
            />
          </Flex>

          <Flex direction="column" gap="2">
            <Text size="2" weight="bold">Content to Write:</Text>
            <textarea
              value={fileInput}
              onChange={(e) => setFileInput(e.target.value)}
              placeholder="Enter file content..."
              style={{
                width: "100%",
                minHeight: 80,
                padding: 8,
                borderRadius: 4,
                border: "1px solid var(--gray-6)",
                background: "var(--gray-2)",
                fontFamily: "monospace",
                fontSize: 12,
                resize: "vertical",
              }}
            />
          </Flex>

          <Flex gap="2" wrap="wrap">
            <Button onClick={writeToStorage} color="green">
              Write
            </Button>
            <Button onClick={readFromStorage} color="blue">
              Read
            </Button>
            <Button onClick={deleteFile} color="red">
              Delete
            </Button>
            <Button onClick={listDirectory} color="purple">
              List Dir
            </Button>
            <Button onClick={getFileStats} color="orange">
              Stats
            </Button>
          </Flex>

          {fileContent && (
            <Card variant="surface">
              <Flex direction="column" gap="1">
                <Text size="2" weight="bold">File Content:</Text>
                <Code style={{ whiteSpace: "pre-wrap", display: "block" }}>{fileContent}</Code>
              </Flex>
            </Card>
          )}

          {directoryListing.length > 0 && (
            <Card variant="surface">
              <Flex direction="column" gap="1">
                <Text size="2" weight="bold">Directory Listing ({getDirectory(filePath)}):</Text>
                <Flex direction="column" gap="1">
                  {directoryListing.map((entry, i) => (
                    <Code key={i} size="1">{entry}</Code>
                  ))}
                </Flex>
              </Flex>
            </Card>
          )}
        </Flex>
      </Card>

      <Separator size="4" />

      {/* Child Panel Demos */}
      <Card>
        <Flex direction="column" gap="3">
          <Heading size="4">Context Modes</Heading>

          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">1. Named Child (Resumable)</Text>
              <Text size="1" color="gray">
                Uses `name` option. Context derived from tree path - deterministic and resumable across restarts.
              </Text>
              <Button onClick={launchNamedChild} size="1">
                Launch Named Child
              </Button>
            </Flex>
          </Card>

          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">2. Unnamed Child (Non-Resumable)</Text>
              <Text size="1" color="gray">
                No `name` option. Panel ID includes random nonce - new context each time.
              </Text>
              <Button onClick={launchUnnamedChild} size="1">
                Launch Unnamed Child
              </Button>
            </Flex>
          </Card>

          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">3. Shared Context</Text>
              <Text size="1" color="gray">
                Explicit `contextId` option. Multiple panels can share the same storage.
              </Text>
              <Flex gap="2" align="end">
                <TextField.Root
                  placeholder="Context ID"
                  value={customContextId}
                  onChange={(e) => setCustomContextId(e.target.value)}
                  style={{ flex: 1 }}
                  size="1"
                />
                <Button onClick={launchSharedContextChild} size="1">
                  Launch Shared
                </Button>
              </Flex>
            </Flex>
          </Card>

          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">4. Isolated Context</Text>
              <Text size="1" color="gray">
                Uses `newContext: true`. Gets a fresh, unique context (safe_named_*) for isolated storage.
              </Text>
              <Button onClick={launchIsolatedChild} size="1">
                Launch Isolated Child
              </Button>
            </Flex>
          </Card>
        </Flex>
      </Card>

      {/* Active Children */}
      {children.length > 0 && (
        <Card>
          <Flex direction="column" gap="2">
            <Heading size="4">Active Children ({children.length})</Heading>
            {children.map((child) => (
              <Flex key={child.id} justify="between" align="center">
                <Code size="1">{child.id}</Code>
                <Button size="1" color="red" variant="soft" onClick={() => closeChild(child)}>
                  Close
                </Button>
              </Flex>
            ))}
          </Flex>
        </Card>
      )}

      {/* Log */}
      {log.length > 0 && (
        <Card>
          <Flex direction="column" gap="2">
            <Heading size="4">Log</Heading>
            <Flex direction="column" gap="1" style={{ fontFamily: "monospace", fontSize: 11 }}>
              {log.map((entry, i) => (
                <Text key={i} size="1" color="gray">
                  {entry}
                </Text>
              ))}
            </Flex>
          </Flex>
        </Card>
      )}
    </Flex>
  );
}
