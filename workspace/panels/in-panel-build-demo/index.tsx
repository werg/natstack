import { useState, useCallback, useEffect } from "react";
import { promises as fsPromises } from "fs";
import {
  Button,
  Card,
  Flex,
  Text,
  Heading,
  Callout,
  Badge,
  TextArea,
  Separator,
  Code,
} from "@radix-ui/themes";
import { panel, usePanelTheme, usePanelId } from "@natstack/panel";
import {
  BrowserPanelBuilder,
  setEsbuildInstance,
  isEsbuildInitialized,
  registerPrebundledBatch,
  CDN_DEFAULTS,
  type BuildFileSystem,
  type EsbuildAPI,
  type EsbuildInitializer,
} from "@natstack/build";

// =============================================================================
// File System Adapter
// =============================================================================

/**
 * Create a BuildFileSystem adapter that wraps the panel's existing ZenFS instance.
 * This ensures the builder sees the same files that were written via fsPromises.
 */
function createFsAdapter(): BuildFileSystem {
  return {
    async readFile(path: string): Promise<string> {
      return fsPromises.readFile(path, "utf-8");
    },
    async readFileBytes(path: string): Promise<Uint8Array> {
      const buffer = await fsPromises.readFile(path);
      return new Uint8Array(buffer);
    },
    async exists(path: string): Promise<boolean> {
      try {
        await fsPromises.access(path);
        return true;
      } catch {
        return false;
      }
    },
    async readdir(path: string): Promise<string[]> {
      const entries = await fsPromises.readdir(path);
      return entries as string[];
    },
    async isDirectory(path: string): Promise<boolean> {
      try {
        const stat = await fsPromises.stat(path);
        return stat.isDirectory();
      } catch {
        return false;
      }
    },
    async glob(): Promise<string[]> {
      // Not implemented for this demo
      return [];
    },
  };
}

// =============================================================================
// esbuild Initialization
// =============================================================================

async function initializeEsbuild(): Promise<void> {
  if (isEsbuildInitialized()) return;

  // Dynamically import esbuild-wasm from CDN
  const module = await import(
    /* @vite-ignore */ "https://esm.sh/esbuild-wasm@0.25.5"
  );

  // esm.sh may wrap the module - check for default export
  const esbuild = (module.default || module) as EsbuildAPI & EsbuildInitializer;

  if (typeof esbuild.initialize !== "function") {
    throw new Error(
      `esbuild.initialize is not a function. Available: ${Object.keys(esbuild).join(", ")}`
    );
  }

  await esbuild.initialize({
    wasmURL: CDN_DEFAULTS.ESBUILD_WASM_BINARY,
  });

  // Register esbuild with @natstack/build
  setEsbuildInstance(esbuild);
}

// =============================================================================
// Demo Panel UI
// =============================================================================

// Default child panel source code
const DEFAULT_CHILD_SOURCE = `import { useState } from "react";
import { Button, Card, Flex, Text, Heading, Badge, Code } from "@radix-ui/themes";
import { panel, usePanelTheme, usePanelId, usePanelEnv } from "@natstack/panel";

export default function DynamicChildPanel() {
  const [count, setCount] = useState(0);
  const theme = usePanelTheme();
  const panelId = usePanelId();
  const env = usePanelEnv();

  return (
    <div style={{ padding: "20px" }}>
      <Card size="3">
        <Flex direction="column" gap="3">
          <Flex align="center" gap="2">
            <Heading size="5">Dynamic Child Panel</Heading>
            <Badge color="green">Built In-Browser!</Badge>
          </Flex>

          <Text size="2">
            This panel was built entirely in the browser using esbuild-wasm,
            with source code from the parent's OPFS.
          </Text>

          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2">Theme: <Text weight="bold">{theme.appearance}</Text></Text>
              <Text size="2">Panel ID: <Code>{panelId}</Code></Text>
              {env.BUILD_TIME && (
                <Text size="2">Built at: <Code>{env.BUILD_TIME}</Code></Text>
              )}
            </Flex>
          </Card>

          <Flex align="center" gap="3">
            <Text size="3">Count: <Text weight="bold">{count}</Text></Text>
            <Button onClick={() => setCount(c => c + 1)}>Increment</Button>
            <Button variant="soft" onClick={() => setCount(0)}>Reset</Button>
          </Flex>

          <Button variant="soft" color="red" onClick={() => panel.close()}>
            Close Panel
          </Button>
        </Flex>
      </Card>
    </div>
  );
}
`;

const DEFAULT_PACKAGE_JSON = `{
  "name": "dynamic-child",
  "natstack": {
    "title": "Dynamic Child",
    "entry": "index.tsx"
  },
  "dependencies": {
    "@natstack/panel": "workspace:*"
  }
}`;

type BuildStatus =
  | { state: "idle" }
  | { state: "initializing" }
  | { state: "writing" }
  | { state: "building" }
  | { state: "launching" }
  | { state: "success"; childId: string }
  | { state: "error"; message: string };

export default function InPanelBuildDemo() {
  usePanelTheme(); // Subscribe to theme changes
  const panelId = usePanelId();

  const [sourceCode, setSourceCode] = useState(DEFAULT_CHILD_SOURCE);
  const [packageJson, setPackageJson] = useState(DEFAULT_PACKAGE_JSON);
  const [buildStatus, setBuildStatus] = useState<BuildStatus>({ state: "idle" });
  const [buildLog, setBuildLog] = useState<string[]>([]);
  const [isInitialized, setIsInitialized] = useState(false);
  const [childPanelIds, setChildPanelIds] = useState<string[]>([]);

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setBuildLog((prev) => [`[${timestamp}] ${message}`, ...prev.slice(0, 19)]);
  }, []);

  // Initialize esbuild-wasm and prebundled packages on mount
  useEffect(() => {
    const initialize = async () => {
      try {
        setBuildStatus({ state: "initializing" });
        addLog("Initializing esbuild-wasm from CDN...");

        await initializeEsbuild();
        addLog("esbuild-wasm initialized");

        // Load prebundled @natstack/* packages from host
        addLog("Loading prebundled packages from host...");
        const prebundled = await panel.getPrebundledPackages();
        const packageNames = Object.keys(prebundled);
        addLog(
          `Loaded ${packageNames.length} prebundled packages: ${packageNames.join(", ")}`
        );

        registerPrebundledBatch(prebundled);
        addLog("Prebundled packages registered");

        setIsInitialized(true);
        setBuildStatus({ state: "idle" });
        addLog("Ready to build!");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setBuildStatus({ state: "error", message });
        addLog(`Initialization failed: ${message}`);
      }
    };

    initialize();
  }, [addLog]);

  const buildAndLaunchChild = async () => {
    if (!isInitialized) {
      addLog("Not initialized yet!");
      return;
    }

    try {
      // Step 1: Write source files to OPFS
      setBuildStatus({ state: "writing" });
      addLog("Writing source files to OPFS...");

      const childPath = "/dynamic-child";

      // Ensure directory exists
      try {
        await fsPromises.mkdir(childPath, { recursive: true });
      } catch {
        // Directory might already exist
      }

      // Write package.json
      await fsPromises.writeFile(`${childPath}/package.json`, packageJson, "utf-8");
      addLog("Wrote package.json");

      // Write index.tsx
      await fsPromises.writeFile(`${childPath}/index.tsx`, sourceCode, "utf-8");
      addLog("Wrote index.tsx");

      // Step 2: Create file system adapter and builder
      setBuildStatus({ state: "building" });
      addLog("Creating builder...");

      const fs = createFsAdapter();
      const builder = new BrowserPanelBuilder({
        basePath: childPath,
        fs,
        dependencyResolver: { cdnBaseUrl: CDN_DEFAULTS.ESM_SH },
      });

      // Step 3: Build the panel
      addLog("Building panel with esbuild-wasm...");
      const result = await builder.build(childPath);

      if (!result.success || !result.artifacts) {
        throw new Error(result.error || "Build failed");
      }

      addLog(
        `Build successful! Bundle size: ${(result.artifacts.bundle.length / 1024).toFixed(1)}KB`
      );

      // Step 4: Launch the child panel
      setBuildStatus({ state: "launching" });
      addLog("Launching child panel...");

      const childId = await panel.launchChild(
        {
          bundle: result.artifacts.bundle,
          html: result.artifacts.html,
          title: result.artifacts.manifest.title,
          css: result.artifacts.css,
          injectHostThemeVariables: result.artifacts.manifest.injectHostThemeVariables,
        },
        {
          env: {
            BUILD_TIME: new Date().toISOString(),
            BUILT_BY: panelId,
          },
        }
      );

      setChildPanelIds((prev) => [...prev, childId]);
      setBuildStatus({ state: "success", childId });
      addLog(`Child panel launched: ${childId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setBuildStatus({ state: "error", message });
      addLog(`Error: ${message}`);
    }
  };

  const removeChild = async (childId: string) => {
    try {
      await panel.removeChild(childId);
      setChildPanelIds((prev) => prev.filter((id) => id !== childId));
      addLog(`Removed child: ${childId}`);
    } catch (error) {
      addLog(
        `Failed to remove child: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const getStatusColor = () => {
    switch (buildStatus.state) {
      case "idle":
        return "gray";
      case "initializing":
      case "writing":
      case "building":
      case "launching":
        return "blue";
      case "success":
        return "green";
      case "error":
        return "red";
    }
  };

  const getStatusText = () => {
    switch (buildStatus.state) {
      case "idle":
        return "Ready";
      case "initializing":
        return "Initializing esbuild-wasm...";
      case "writing":
        return "Writing source to OPFS...";
      case "building":
        return "Building with esbuild-wasm...";
      case "launching":
        return "Launching child panel...";
      case "success":
        return `Success! Launched: ${buildStatus.childId}`;
      case "error":
        return `Error: ${buildStatus.message}`;
    }
  };

  return (
    <div style={{ padding: "20px" }}>
      <Card size="3" style={{ width: "100%" }}>
        <Flex direction="column" gap="4">
          <Flex align="center" gap="3">
            <Heading size="6">In-Panel Build Demo</Heading>
            <Badge color={isInitialized ? "green" : "orange"}>
              {isInitialized ? "Ready" : "Initializing..."}
            </Badge>
          </Flex>

          <Text size="2" color="gray">
            This demo shows how a panel can build and launch child panels
            entirely in the browser using esbuild-wasm, OPFS storage, and
            CDN-based npm dependency resolution.
          </Text>

          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">
                How it works:
              </Text>
              <Text size="1" color="gray">
                1. Source code is written to this panel's OPFS partition
              </Text>
              <Text size="1" color="gray">
                2. esbuild-wasm bundles the code in-browser
              </Text>
              <Text size="1" color="gray">
                3. @natstack/* packages are resolved from prebundled modules
              </Text>
              <Text size="1" color="gray">
                4. Other npm packages are resolved via esm.sh CDN
              </Text>
              <Text size="1" color="gray">
                5. The bundle is passed to the host which serves it via a custom
                protocol
              </Text>
            </Flex>
          </Card>

          <Separator size="4" />

          <Heading size="4">Child Panel Source</Heading>

          <Flex direction="column" gap="2">
            <Text size="2" weight="bold">
              package.json:
            </Text>
            <TextArea
              value={packageJson}
              onChange={(e) => setPackageJson(e.target.value)}
              style={{
                fontFamily: "monospace",
                fontSize: "12px",
                minHeight: "80px",
              }}
            />
          </Flex>

          <Flex direction="column" gap="2">
            <Text size="2" weight="bold">
              index.tsx:
            </Text>
            <TextArea
              value={sourceCode}
              onChange={(e) => setSourceCode(e.target.value)}
              style={{
                fontFamily: "monospace",
                fontSize: "12px",
                minHeight: "300px",
              }}
            />
          </Flex>

          <Flex gap="3">
            <Button
              onClick={buildAndLaunchChild}
              disabled={
                !isInitialized ||
                (buildStatus.state !== "idle" &&
                  buildStatus.state !== "success" &&
                  buildStatus.state !== "error")
              }
              size="3"
            >
              Build & Launch Child
            </Button>
            <Button
              variant="soft"
              onClick={() => {
                setSourceCode(DEFAULT_CHILD_SOURCE);
                setPackageJson(DEFAULT_PACKAGE_JSON);
              }}
            >
              Reset to Default
            </Button>
          </Flex>

          <Callout.Root color={getStatusColor()}>
            <Callout.Text>{getStatusText()}</Callout.Text>
          </Callout.Root>

          {childPanelIds.length > 0 && (
            <>
              <Separator size="4" />
              <Heading size="4">Launched Children</Heading>
              <Flex direction="column" gap="2">
                {childPanelIds.map((childId) => (
                  <Flex key={childId} align="center" gap="2">
                    <Code style={{ flex: 1 }}>{childId}</Code>
                    <Button
                      variant="soft"
                      color="red"
                      size="1"
                      onClick={() => removeChild(childId)}
                    >
                      Remove
                    </Button>
                  </Flex>
                ))}
              </Flex>
            </>
          )}

          <Separator size="4" />

          <Heading size="4">Build Log</Heading>
          <Card
            variant="surface"
            style={{ maxHeight: "200px", overflowY: "auto" }}
          >
            <Flex direction="column" gap="1">
              {buildLog.length === 0 ? (
                <Text size="1" color="gray">
                  No log entries yet
                </Text>
              ) : (
                buildLog.map((entry, i) => (
                  <Text key={i} size="1" style={{ fontFamily: "monospace" }}>
                    {entry}
                  </Text>
                ))
              )}
            </Flex>
          </Card>
        </Flex>
      </Card>
    </div>
  );
}
