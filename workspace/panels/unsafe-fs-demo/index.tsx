import { useState, useEffect } from "react";
import { promises as fsPromises, readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve } from "path";
import { homedir, platform, arch, cpus } from "os";
import { Button, Card, Flex, Text, Heading, Callout, Badge, Code, Separator } from "@radix-ui/themes";
import { usePanelId } from "@natstack/react";

/**
 * Unsafe FS Demo Panel
 *
 * This panel runs with nodeIntegration enabled and has access to real Node.js APIs.
 * It demonstrates:
 * - Real fs module (not OPFS/ZenFS)
 * - Sync filesystem operations
 * - Access to workspace files
 * - Full process.env
 * - System information via os module
 */

export default function UnsafeFsDemo() {
  const panelId = usePanelId();
  const [status, setStatus] = useState<string>("");
  const [fileContent, setFileContent] = useState<string>("");
  const [dirListing, setDirListing] = useState<string[]>([]);

  // Read globals set by unsafe preload
  const fsRoot = (globalThis as any).__natstackFsRoot as string | undefined;
  const natstackId = (globalThis as any).__natstackId as string;
  const natstackKind = (globalThis as any).__natstackKind as string;
  const workspaceEnv = process.env.NATSTACK_WORKSPACE;

  // System info available via os module
  const systemInfo = {
    platform: platform(),
    arch: arch(),
    homedir: homedir(),
    cpuCount: cpus().length,
    nodeVersion: process.version,
  };

  useEffect(() => {
    setStatus("✅ Panel loaded with unsafe mode - Node.js APIs available!");
  }, []);

  // Test 1: Read workspace package.json using SYNC fs (not available in OPFS)
  const readWorkspacePackageJson = () => {
    try {
      setStatus("Reading workspace package.json using sync fs.readFileSync()...");

      if (!workspaceEnv) {
        setStatus("❌ NATSTACK_WORKSPACE env var not set");
        return;
      }

      const pkgPath = join(workspaceEnv, "package.json");
      // Use SYNC API - this wouldn't work in OPFS/browser!
      const content = readFileSync(pkgPath, "utf-8");

      setFileContent(content);
      setStatus(`✅ Successfully read ${pkgPath} using sync API!`);
    } catch (error) {
      setStatus(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Test 2: List workspace root using SYNC fs
  const listWorkspaceRoot = () => {
    try {
      setStatus("Listing workspace root using sync fs.readdirSync()...");

      if (!workspaceEnv) {
        setStatus("❌ NATSTACK_WORKSPACE env var not set");
        return;
      }

      // Use SYNC API
      const files = readdirSync(workspaceEnv);

      setDirListing(files);
      setStatus(`✅ Found ${files.length} items in workspace root`);
    } catch (error) {
      setStatus(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Test 3: Read this panel's source code
  const readOwnSourceCode = async () => {
    try {
      setStatus("Reading this panel's own source code...");

      if (!workspaceEnv) {
        setStatus("❌ NATSTACK_WORKSPACE env var not set");
        return;
      }

      const sourcePath = join(workspaceEnv, "panels", "unsafe-fs-demo", "index.tsx");

      // Use async API
      const content = await fsPromises.readFile(sourcePath, "utf-8");

      // Show first 500 chars
      setFileContent(content.slice(0, 500) + "\n\n... (truncated)");
      setStatus(`✅ Successfully read own source: ${sourcePath}`);
    } catch (error) {
      setStatus(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Test 4: Check filesystem scope root
  const checkScopeRoot = () => {
    if (!fsRoot) {
      setStatus("⚠️ No __natstackFsRoot set (full access mode)");
      setFileContent("No scope root defined - panel has full filesystem access!");
      return;
    }

    try {
      setStatus(`Checking scope root: ${fsRoot}`);

      const exists = existsSync(fsRoot);
      const files = exists ? readdirSync(fsRoot) : [];

      setDirListing(files);
      setFileContent(`Scope root: ${fsRoot}\nExists: ${exists}\nFiles: ${files.length}`);
      setStatus(`✅ Scope root accessible with ${files.length} files`);
    } catch (error) {
      setStatus(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Test 5: Write to scope directory
  const writeTestFile = async () => {
    try {
      if (!fsRoot) {
        setStatus("⚠️ No scope root - writing to /tmp instead");
        const testPath = "/tmp/natstack-unsafe-test.txt";
        await fsPromises.writeFile(testPath, `Test from ${panelId} at ${new Date().toISOString()}`);
        setStatus(`✅ Wrote to ${testPath}`);
        return;
      }

      setStatus(`Writing test file to scope root: ${fsRoot}`);

      const testPath = join(fsRoot, "test.txt");
      const content = `Unsafe panel test\nPanel ID: ${panelId}\nTime: ${new Date().toISOString()}`;

      await fsPromises.writeFile(testPath, content, "utf-8");

      // Read it back to verify
      const readBack = await fsPromises.readFile(testPath, "utf-8");

      setFileContent(readBack);
      setStatus(`✅ Successfully wrote and read back ${testPath}`);
    } catch (error) {
      setStatus(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Test 6: Demonstrate require() works
  const testDynamicRequire = () => {
    try {
      setStatus("Testing dynamic require()...");

      // Dynamically require crypto module
      const crypto = require("crypto");
      const hash = crypto.createHash("sha256").update("NatStack Unsafe Panel").digest("hex");

      setFileContent(`SHA256 hash of "NatStack Unsafe Panel":\n${hash}`);
      setStatus("✅ Successfully used require('crypto') dynamically!");
    } catch (error) {
      setStatus(`❌ Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div style={{ padding: "20px" }}>
      <Card size="3">
        <Flex direction="column" gap="4">
          <Flex align="center" gap="3">
            <Heading size="6">🔓 Unsafe FS Demo</Heading>
            <Badge color="red">UNSAFE MODE</Badge>
          </Flex>

          <Callout.Root color="orange">
            <Callout.Text>
              This panel runs with <Code>nodeIntegration: true</Code> and has full Node.js API access.
              It can read/write the real filesystem, not OPFS.
            </Callout.Text>
          </Callout.Root>

          {/* System Information */}
          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">System Information (via os module):</Text>
              <Text size="1" style={{ fontFamily: "monospace" }}>Platform: {systemInfo.platform}</Text>
              <Text size="1" style={{ fontFamily: "monospace" }}>Architecture: {systemInfo.arch}</Text>
              <Text size="1" style={{ fontFamily: "monospace" }}>CPUs: {systemInfo.cpuCount}</Text>
              <Text size="1" style={{ fontFamily: "monospace" }}>Node.js: {systemInfo.nodeVersion}</Text>
              <Text size="1" style={{ fontFamily: "monospace" }}>Home: {systemInfo.homedir}</Text>
            </Flex>
          </Card>

          {/* NatStack Globals */}
          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">NatStack Globals:</Text>
              <Text size="1" style={{ fontFamily: "monospace" }}>__natstackId: {natstackId}</Text>
              <Text size="1" style={{ fontFamily: "monospace" }}>__natstackKind: {natstackKind}</Text>
              <Text size="1" style={{ fontFamily: "monospace" }}>__natstackFsRoot: {fsRoot || "(not set - full access)"}</Text>
              <Text size="1" style={{ fontFamily: "monospace" }}>NATSTACK_WORKSPACE: {workspaceEnv || "(not set)"}</Text>
            </Flex>
          </Card>

          <Separator size="4" />

          {/* Test Buttons */}
          <Heading size="4">Filesystem Tests</Heading>
          <Text size="2" color="gray">
            These tests demonstrate real Node.js filesystem access (NOT browser OPFS):
          </Text>

          <Flex direction="column" gap="2">
            <Button onClick={readWorkspacePackageJson} variant="soft">
              1. Read Workspace package.json (Sync API)
            </Button>
            <Button onClick={listWorkspaceRoot} variant="soft" color="blue">
              2. List Workspace Root (Sync API)
            </Button>
            <Button onClick={readOwnSourceCode} variant="soft" color="green">
              3. Read Own Source Code (Async API)
            </Button>
            <Button onClick={checkScopeRoot} variant="soft" color="purple">
              4. Check Filesystem Scope Root
            </Button>
            <Button onClick={writeTestFile} variant="soft" color="orange">
              5. Write Test File to Scope
            </Button>
            <Button onClick={testDynamicRequire} variant="soft" color="cyan">
              6. Test Dynamic require()
            </Button>
          </Flex>

          {/* Status */}
          {status && (
            <Callout.Root color={status.includes("❌") ? "red" : status.includes("⚠️") ? "orange" : "green"}>
              <Callout.Text>{status}</Callout.Text>
            </Callout.Root>
          )}

          {/* File Content Display */}
          {fileContent && (
            <Card variant="surface">
              <Flex direction="column" gap="2">
                <Text size="2" weight="bold">Content:</Text>
                <Text
                  size="1"
                  style={{
                    fontFamily: "monospace",
                    whiteSpace: "pre-wrap",
                    maxHeight: "300px",
                    overflowY: "auto",
                    background: "var(--gray-2)",
                    padding: "8px",
                    borderRadius: "4px",
                  }}
                >
                  {fileContent}
                </Text>
              </Flex>
            </Card>
          )}

          {/* Directory Listing */}
          {dirListing.length > 0 && (
            <Card variant="surface">
              <Flex direction="column" gap="2">
                <Text size="2" weight="bold">Directory Contents ({dirListing.length} items):</Text>
                <div style={{ maxHeight: "200px", overflowY: "auto" }}>
                  {dirListing.map((file, i) => (
                    <Text key={i} size="1" style={{ fontFamily: "monospace", display: "block" }}>
                      {file}
                    </Text>
                  ))}
                </div>
              </Flex>
            </Card>
          )}

          <Separator size="4" />

          {/* Technical Details */}
          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">Technical Details:</Text>
              <Text size="1" color="gray">
                • This panel uses <Code>import fs from "fs"</Code> - the REAL Node.js fs module
              </Text>
              <Text size="1" color="gray">
                • Sync APIs like <Code>readFileSync()</Code> work (not available in OPFS)
              </Text>
              <Text size="1" color="gray">
                • Can access files outside the browser sandbox
              </Text>
              <Text size="1" color="gray">
                • Full <Code>process.env</Code> access (not synthetic)
              </Text>
              <Text size="1" color="gray">
                • Can <Code>require()</Code> any Node.js built-in module dynamically
              </Text>
              <Text size="1" color="gray">
                • Runs with <Code>contextIsolation: false</Code>, <Code>sandbox: false</Code>
              </Text>
            </Flex>
          </Card>
        </Flex>
      </Card>
    </div>
  );
}
