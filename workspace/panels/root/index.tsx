import { useState, useCallback } from "react";
import { promises as fsPromises } from "fs";
import { Button, Card, Flex, Text, Heading, Callout, Separator, Badge, TextField } from "@radix-ui/themes";
import { panel } from "@natstack/panel";
import {
  usePanelTheme,
  usePanelId,
  usePanelPartition,
  usePanelEnv,
  usePanelRpc,
  usePanelRpcGlobalEvent,
} from "@natstack/react";
import "./style.css";

import { type RpcDemoChildApi } from "../typed-rpc-child/api.js";
import { type RpcExampleWorkerApi } from "../../workers/rpc-example/api.js";

export default function ChildPanelLauncher() {
  const [status, setStatus] = useState<string>("");
  const theme = usePanelTheme();
  const panelId = usePanelId();
  const partition = usePanelPartition();
  const env = usePanelEnv();

  const [opfsStatus, setOpfsStatus] = useState<string>("");
  const [opfsContent, setOpfsContent] = useState<string>("");

  // RPC Demo state (panel child)
  const [rpcChildId, setRpcChildId] = useState<string | null>(null);
  const rpcChildHandle = usePanelRpc<RpcDemoChildApi>(rpcChildId);
  const [rpcLog, setRpcLog] = useState<string[]>([]);
  const [echoInput, setEchoInput] = useState("");
  const [incrementAmount, setIncrementAmount] = useState("1");
  const [childEvents, setChildEvents] = useState<string[]>([]);

  // Worker RPC Demo state
  const [workerId, setWorkerId] = useState<string | null>(null);
  const workerHandle = usePanelRpc<RpcExampleWorkerApi>(workerId);
  const [workerLog, setWorkerLog] = useState<string[]>([]);
  const [workerEchoInput, setWorkerEchoInput] = useState("");
  const [workerIncrementAmount, setWorkerIncrementAmount] = useState("1");
  const [workerSumInput, setWorkerSumInput] = useState("1, 2, 3, 4, 5");
  const [workerEvents, setWorkerEvents] = useState<string[]>([]);

  // Browser Automation Demo state
  const [browserId, setBrowserId] = useState<string | null>(null);
  const [browserLog, setBrowserLog] = useState<string[]>([]);
  const [browserUrlInput, setBrowserUrlInput] = useState("https://example.com");

  const addRpcLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setRpcLog((prev) => [`[${timestamp}] ${message}`, ...prev.slice(0, 9)]);
  }, []);

  const addWorkerLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setWorkerLog((prev) => [`[${timestamp}] ${message}`, ...prev.slice(0, 9)]);
  }, []);

  const addBrowserLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setBrowserLog((prev) => [`[${timestamp}] ${message}`, ...prev.slice(0, 19)]);
  }, []);

  // Listen for events from child panels
  usePanelRpcGlobalEvent("childUpdate", (fromPanelId: string, payload: unknown) => {
    const timestamp = new Date().toLocaleTimeString();
    setChildEvents((prev) => [
      `[${timestamp}] From ${fromPanelId}: ${JSON.stringify(payload)}`,
      ...prev.slice(0, 4),
    ]);
  });

  // Get env variables that were passed from parent
  const parentId = env.PARENT_ID;
  const launchTime = env.LAUNCH_TIME;
  const message = env.MESSAGE;

  const launchChildPanel = async () => {
    try {
      setStatus("Launching child panel...");
      const childId = await panel.createChild({
        type: "app",
        name: "another-root",
        path: "panels/root",
        env: {
          PARENT_ID: panelId,
          LAUNCH_TIME: new Date().toISOString(),
          MESSAGE: "Hello from parent panel!",
        },
      });
      setStatus(`Launched child ${childId}`);
    } catch (error) {
      setStatus(`Failed to launch child: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const launchSharedOPFSDemo = async () => {
    try {
      setStatus("Launching shared OPFS demo panel...");
      const childId = await panel.createChild({
        type: "app",
        name: "shared-opfs-demo",
        path: "panels/shared-opfs-demo",
      });
      setStatus(`Launched shared OPFS demo panel ${childId}`);
    } catch (error) {
      setStatus(`Failed to launch: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const launchAgenticChat = async () => {
    try {
      setStatus("Launching agentic chat example...");
      const childId = await panel.createChild({
        type: "app",
        name: "agentic-chat",
        path: "panels/agentic-chat",
      });
      setStatus(`Launched agentic chat panel ${childId}`);
    } catch (error) {
      setStatus(`Failed to launch agentic chat: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const launchAgenticNotebook = async () => {
    try {
      setStatus("Launching agentic notebook...");
      const childId = await panel.createChild({
        type: "app",
        name: "agentic-notebook",
        path: "panels/agentic-notebook",
      });
      setStatus(`Launched agentic notebook panel ${childId}`);
    } catch (error) {
      setStatus(`Failed to launch agentic notebook: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const setRandomTitle = async () => {
    const title = `Radix Panel ${Math.floor(Math.random() * 1000)}`;
    await panel.setTitle(title);
    setStatus(`Title set to ${title}`);
  };

  const exampleFilePath = "/example.txt";

  // OPFS (Origin Private File System) example functions via fs (ZenFS WebAccess backend)
  const writeToOPFS = async () => {
    try {
      setOpfsStatus("Writing to OPFS...");

      const timestamp = new Date().toISOString();
      const content = `Hello from NatStack panel!\nWritten at: ${timestamp}\nPanel ID: ${panelId}`;
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

  // ===========================================================================
  // RPC Demo Functions
  // ===========================================================================

  const launchRpcDemoChild = async () => {
    try {
      addRpcLog("Launching RPC demo child panel...");
      const childId = await panel.createChild({
        type: "app",
        name: "typed-rpc-child",
        path: "panels/typed-rpc-child",
        env: { PARENT_ID: panelId },
      });
      setRpcChildId(childId);
      addRpcLog(`Child panel launched: ${childId}`);
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const callPing = async () => {
    if (!rpcChildHandle) {
      addRpcLog("No child panel connected");
      return;
    }
    try {
      addRpcLog("Calling ping()...");
      const result = await rpcChildHandle.call.ping();
      addRpcLog(`Result: "${result}"`);
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const callEcho = async () => {
    if (!rpcChildHandle) {
      addRpcLog("No child panel connected");
      return;
    }
    try {
      const msg = echoInput || "Hello!";
      addRpcLog(`Calling echo("${msg}")...`);
      const result = await rpcChildHandle.call.echo(msg);
      addRpcLog(`Result: "${result}"`);
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const callGetCounter = async () => {
    if (!rpcChildHandle) {
      addRpcLog("No child panel connected");
      return;
    }
    try {
      addRpcLog("Calling getCounter()...");
      const result = await rpcChildHandle.call.getCounter();
      addRpcLog(`Result: ${result}`);
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const callIncrementCounter = async () => {
    if (!rpcChildHandle) {
      addRpcLog("No child panel connected");
      return;
    }
    try {
      const amount = parseInt(incrementAmount) || 1;
      addRpcLog(`Calling incrementCounter(${amount})...`);
      const result = await rpcChildHandle.call.incrementCounter(amount);
      addRpcLog(`Result: ${result}`);
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const callResetCounter = async () => {
    if (!rpcChildHandle) {
      addRpcLog("No child panel connected");
      return;
    }
    try {
      addRpcLog("Calling resetCounter()...");
      await rpcChildHandle.call.resetCounter();
      addRpcLog("Counter reset successfully");
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const callGetInfo = async () => {
    if (!rpcChildHandle) {
      addRpcLog("No child panel connected");
      return;
    }
    try {
      addRpcLog("Calling getInfo()...");
      const result = await rpcChildHandle.call.getInfo();
      addRpcLog(`Result: ${JSON.stringify(result)}`);
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const sendEventToChild = () => {
    if (!rpcChildId) {
      addRpcLog("No child panel connected");
      return;
    }
    const payload = { message: "Hello from parent!", timestamp: new Date().toISOString() };
    panel.rpc.emit(rpcChildId, "parentMessage", payload);
    addRpcLog(`Sent 'parentMessage' event: ${JSON.stringify(payload)}`);
  };

  // ===========================================================================
  // Worker RPC Demo Functions
  // ===========================================================================

  const launchRpcWorker = async () => {
    try {
      addWorkerLog("Launching RPC example worker...");
      const id = await panel.createChild({
        type: "worker",
        name: "rpc-example-worker",
        path: "workers/rpc-example",
        env: { PARENT_ID: panelId },
      });
      setWorkerId(id);
      addWorkerLog(`Worker launched: ${id}`);
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCallPing = async () => {
    if (!workerHandle) {
      addWorkerLog("No worker connected");
      return;
    }
    try {
      addWorkerLog("Calling ping()...");
      const result = await workerHandle.call.ping();
      addWorkerLog(`Result: "${result}"`);
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCallEcho = async () => {
    if (!workerHandle) {
      addWorkerLog("No worker connected");
      return;
    }
    try {
      const msg = workerEchoInput || "Hello from panel!";
      addWorkerLog(`Calling echo("${msg}")...`);
      const result = await workerHandle.call.echo(msg);
      addWorkerLog(`Result: "${result}"`);
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCallGetCounter = async () => {
    if (!workerHandle) {
      addWorkerLog("No worker connected");
      return;
    }
    try {
      addWorkerLog("Calling getCounter()...");
      const result = await workerHandle.call.getCounter();
      addWorkerLog(`Result: ${result}`);
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCallIncrementCounter = async () => {
    if (!workerHandle) {
      addWorkerLog("No worker connected");
      return;
    }
    try {
      const amount = parseInt(workerIncrementAmount) || 1;
      addWorkerLog(`Calling incrementCounter(${amount})...`);
      const result = await workerHandle.call.incrementCounter(amount);
      addWorkerLog(`Result: ${result}`);
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCallResetCounter = async () => {
    if (!workerHandle) {
      addWorkerLog("No worker connected");
      return;
    }
    try {
      addWorkerLog("Calling resetCounter()...");
      await workerHandle.call.resetCounter();
      addWorkerLog("Counter reset successfully");
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCallGetInfo = async () => {
    if (!workerHandle) {
      addWorkerLog("No worker connected");
      return;
    }
    try {
      addWorkerLog("Calling getWorkerInfo()...");
      const result = await workerHandle.call.getWorkerInfo();
      addWorkerLog(`Result: ${JSON.stringify(result)}`);
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCallComputeSum = async () => {
    if (!workerHandle) {
      addWorkerLog("No worker connected");
      return;
    }
    try {
      const numbers = workerSumInput.split(",").map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n));
      addWorkerLog(`Calling computeSum([${numbers.join(", ")}])...`);
      const result = await workerHandle.call.computeSum(numbers);
      addWorkerLog(`Result: ${result}`);
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const sendEventToWorker = () => {
    if (!workerId) {
      addWorkerLog("No worker connected");
      return;
    }
    const payload = { message: "Hello from panel!", timestamp: new Date().toISOString() };
    panel.rpc.emit(workerId, "parentMessage", payload);
    addWorkerLog(`Sent 'parentMessage' event: ${JSON.stringify(payload)}`);
  };

  // Listen for events from worker
  usePanelRpcGlobalEvent("counter-changed", (fromId: string, payload: unknown) => {
    if (fromId === workerId) {
      const timestamp = new Date().toLocaleTimeString();
      setWorkerEvents((prev) => [
        `[${timestamp}] counter-changed: ${JSON.stringify(payload)}`,
        ...prev.slice(0, 4),
      ]);
    }
  });

  usePanelRpcGlobalEvent("ping-received", (fromId: string, payload: unknown) => {
    if (fromId === workerId) {
      const timestamp = new Date().toLocaleTimeString();
      setWorkerEvents((prev) => [
        `[${timestamp}] ping-received: ${JSON.stringify(payload)}`,
        ...prev.slice(0, 4),
      ]);
    }
  });

  usePanelRpcGlobalEvent("reset", (fromId: string, payload: unknown) => {
    if (fromId === workerId) {
      const timestamp = new Date().toLocaleTimeString();
      setWorkerEvents((prev) => [
        `[${timestamp}] reset: ${JSON.stringify(payload)}`,
        ...prev.slice(0, 4),
      ]);
    }
  });

  // ===========================================================================
  // Browser Automation Demo Functions
  // ===========================================================================

  const launchBrowser = async () => {
    try {
      addBrowserLog("Launching browser panel...");
      const id = await panel.createChild({
        type: "browser",
        name: "demo-browser",
        url: browserUrlInput,
        title: "Demo Browser",
      });
      setBrowserId(id);
      addBrowserLog(`Browser launched: ${id}`);
    } catch (error) {
      addBrowserLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /**
   * Browser automation using Playwright API.
   * TODO: Implement proper Playwright shim over CDP.
   */
  const runPlaywrightDemo = async () => {
    if (!browserId) {
      addBrowserLog("No browser launched - launch one first!");
      return;
    }

    try {
      addBrowserLog("Getting CDP endpoint...");
      const cdpUrl = await panel.browser.getCdpEndpoint(browserId);
      addBrowserLog(`CDP endpoint: ${cdpUrl}`);

      addBrowserLog("TODO: Implement Playwright API shim over CDP");
      addBrowserLog("The challenge: Playwright's Connection class expects a Playwright server,");
      addBrowserLog("not raw CDP. We need to build a shim that translates Playwright API calls");
      addBrowserLog("into CDP commands.");

    } catch (error) {
      addBrowserLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const closeBrowser = async () => {
    if (!browserId) {
      addBrowserLog("No browser to close");
      return;
    }
    try {
      addBrowserLog(`Closing browser ${browserId}...`);
      await panel.removeChild(browserId);
      setBrowserId(null);
      addBrowserLog("Browser closed");
    } catch (error) {
      addBrowserLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  return (
    <div style={{ padding: "20px" }}>
      <Card size="3" style={{ width: "100%" }}>
        <Flex direction="column" gap="4">
          <Flex align="center" gap="3">
            <Heading size="6">React + Radix Panel</Heading>
            <Badge color="orange">
              Partition / Panel ID: {partition ?? "loading..."}
            </Badge>
          </Flex>
          <Text size="2">
            Current theme: <Text weight="bold">{theme.appearance}</Text>
          </Text>
          <Text size="2">
            Panel ID: <Text weight="bold">{panelId}</Text>
          </Text>
          <Text size="2">
            Partition: <Text weight="bold" style={{ fontFamily: "monospace" }}>
              {partition ?? "loading..."}
            </Text>
          </Text>
          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">Partition Rules:</Text>
              <Text size="1" color="gray">
                • <Text weight="bold">Tree panels:</Text> Children can set <Text weight="bold">panelId</Text> and get <Text weight="bold">tree/&lt;parent-id-without-tree-prefix&gt;/&lt;panelId&gt;</Text>.
              </Text>
              <Text size="1" color="gray">
                • <Text weight="bold">Singleton panels:</Text> Manifests with <Text weight="bold">singletonState: true</Text> use <Text weight="bold">singleton/&lt;relative-path&gt;</Text> and cannot be overridden.
              </Text>
              <Text size="1" color="gray">
                • <Text weight="bold">One per partition:</Text> Creating a panel for an existing partition ID throws and the parent call fails.
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
            <Button onClick={launchChildPanel}>Launch Root Panel</Button>
            <Button onClick={launchSharedOPFSDemo} color="purple">
              Launch Shared OPFS Demo
            </Button>
            <Button onClick={launchAgenticChat} color="green">
              Launch Agentic Chat
            </Button>
            <Button onClick={launchAgenticNotebook} color="blue">
              Launch Agentic Notebook
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
            This panel writes to "example.txt". Each partition (which equals the panel ID) has its own OPFS. Reusing the same panel ID (tree/singleton) shares storage; new IDs get fresh storage.
          </Text>
          {message && message.includes("share OPFS") && (
            <Callout.Root color="orange">
              <Callout.Text>
                This instance is using partition {partition ?? "(loading)"} — files are shared with any panel using the same ID.
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

          <Separator size="4" />

          {/* Panel-to-Panel RPC Demo Section */}
          <Heading size="5">Panel-to-Panel RPC Demo</Heading>
          <Text size="2" color="gray">
            Demonstrates typed RPC communication between parent and child panels.
            The child exposes methods that the parent can call with full type safety.
          </Text>

          <Flex gap="2" wrap="wrap">
            <Button onClick={launchRpcDemoChild} color="cyan" disabled={!!rpcChildHandle}>
              {rpcChildHandle ? "Child Connected" : "Launch RPC Demo Child"}
            </Button>
          </Flex>

          {rpcChildHandle && (
            <>
              <Card variant="surface">
                <Flex direction="column" gap="3">
                  <Flex align="center" gap="2">
                    <Text size="2" weight="bold">Connected to:</Text>
                    <Badge color="green" style={{ fontFamily: "monospace" }}>
                      {rpcChildId}
                    </Badge>
                  </Flex>

                  <Text size="2" weight="bold">Call Methods:</Text>
                  <Flex gap="2" wrap="wrap">
                    <Button onClick={callPing} variant="soft" size="1">
                      ping()
                    </Button>
                    <Button onClick={callGetCounter} variant="soft" size="1">
                      getCounter()
                    </Button>
                    <Button onClick={callResetCounter} variant="soft" size="1" color="red">
                      resetCounter()
                    </Button>
                    <Button onClick={callGetInfo} variant="soft" size="1">
                      getInfo()
                    </Button>
                  </Flex>

                  <Flex gap="2" align="end">
                    <Flex direction="column" gap="1" style={{ flex: 1 }}>
                      <Text size="1" weight="bold">Echo Message:</Text>
                      <TextField.Root
                        placeholder="Enter message..."
                        value={echoInput}
                        onChange={(e) => setEchoInput(e.target.value)}
                        size="1"
                      />
                    </Flex>
                    <Button onClick={callEcho} variant="soft" size="1">
                      echo()
                    </Button>
                  </Flex>

                  <Flex gap="2" align="end">
                    <Flex direction="column" gap="1" style={{ width: "100px" }}>
                      <Text size="1" weight="bold">Amount:</Text>
                      <TextField.Root
                        type="number"
                        value={incrementAmount}
                        onChange={(e) => setIncrementAmount(e.target.value)}
                        size="1"
                      />
                    </Flex>
                    <Button onClick={callIncrementCounter} variant="soft" size="1" color="green">
                      incrementCounter()
                    </Button>
                  </Flex>

                  <Separator size="4" />

                  <Text size="2" weight="bold">Events:</Text>
                  <Button onClick={sendEventToChild} variant="soft" size="1" color="orange">
                    Send "parentMessage" Event to Child
                  </Button>
                </Flex>
              </Card>

              {childEvents.length > 0 && (
                <Card variant="surface">
                  <Flex direction="column" gap="1">
                    <Text size="2" weight="bold">Events from Child:</Text>
                    {childEvents.map((event, i) => (
                      <Text key={i} size="1" style={{ fontFamily: "monospace" }}>
                        {event}
                      </Text>
                    ))}
                  </Flex>
                </Card>
              )}
            </>
          )}

          {rpcLog.length > 0 && (
            <Card variant="surface" style={{ maxHeight: "200px", overflowY: "auto" }}>
              <Flex direction="column" gap="1">
                <Text size="2" weight="bold">RPC Log:</Text>
                {rpcLog.map((entry, i) => (
                  <Text key={i} size="1" style={{ fontFamily: "monospace" }}>
                    {entry}
                  </Text>
                ))}
              </Flex>
            </Card>
          )}

          <Separator size="4" />

          {/* Worker RPC Demo Section */}
          <Heading size="5">Worker RPC Demo</Heading>
          <Text size="2" color="gray">
            Demonstrates RPC communication between a panel and an isolated worker.
            Workers run in a sandboxed environment with their own filesystem and limited capabilities.
          </Text>

          <Flex gap="2" wrap="wrap">
            <Button onClick={launchRpcWorker} color="orange" disabled={!!workerHandle}>
              {workerHandle ? "Worker Connected" : "Launch RPC Example Worker"}
            </Button>
          </Flex>

          {workerHandle && (
            <>
              <Card variant="surface">
                <Flex direction="column" gap="3">
                  <Flex align="center" gap="2">
                    <Text size="2" weight="bold">Connected to:</Text>
                    <Badge color="orange" style={{ fontFamily: "monospace" }}>
                      {workerId}
                    </Badge>
                  </Flex>

                  <Text size="2" weight="bold">Call Methods:</Text>
                  <Flex gap="2" wrap="wrap">
                    <Button onClick={workerCallPing} variant="soft" size="1">
                      ping()
                    </Button>
                    <Button onClick={workerCallGetCounter} variant="soft" size="1">
                      getCounter()
                    </Button>
                    <Button onClick={workerCallResetCounter} variant="soft" size="1" color="red">
                      resetCounter()
                    </Button>
                    <Button onClick={workerCallGetInfo} variant="soft" size="1">
                      getWorkerInfo()
                    </Button>
                  </Flex>

                  <Flex gap="2" align="end">
                    <Flex direction="column" gap="1" style={{ flex: 1 }}>
                      <Text size="1" weight="bold">Echo Message:</Text>
                      <TextField.Root
                        placeholder="Enter message..."
                        value={workerEchoInput}
                        onChange={(e) => setWorkerEchoInput(e.target.value)}
                        size="1"
                      />
                    </Flex>
                    <Button onClick={workerCallEcho} variant="soft" size="1">
                      echo()
                    </Button>
                  </Flex>

                  <Flex gap="2" align="end">
                    <Flex direction="column" gap="1" style={{ width: "100px" }}>
                      <Text size="1" weight="bold">Amount:</Text>
                      <TextField.Root
                        type="number"
                        value={workerIncrementAmount}
                        onChange={(e) => setWorkerIncrementAmount(e.target.value)}
                        size="1"
                      />
                    </Flex>
                    <Button onClick={workerCallIncrementCounter} variant="soft" size="1" color="green">
                      incrementCounter()
                    </Button>
                  </Flex>

                  <Flex gap="2" align="end">
                    <Flex direction="column" gap="1" style={{ flex: 1 }}>
                      <Text size="1" weight="bold">Numbers (comma-separated):</Text>
                      <TextField.Root
                        placeholder="1, 2, 3, 4, 5"
                        value={workerSumInput}
                        onChange={(e) => setWorkerSumInput(e.target.value)}
                        size="1"
                      />
                    </Flex>
                    <Button onClick={workerCallComputeSum} variant="soft" size="1" color="purple">
                      computeSum()
                    </Button>
                  </Flex>

                  <Separator size="4" />

                  <Text size="2" weight="bold">Events:</Text>
                  <Button onClick={sendEventToWorker} variant="soft" size="1" color="orange">
                    Send "parentMessage" Event to Worker
                  </Button>
                </Flex>
              </Card>

              {workerEvents.length > 0 && (
                <Card variant="surface">
                  <Flex direction="column" gap="1">
                    <Text size="2" weight="bold">Events from Worker:</Text>
                    {workerEvents.map((event, i) => (
                      <Text key={i} size="1" style={{ fontFamily: "monospace" }}>
                        {event}
                      </Text>
                    ))}
                  </Flex>
                </Card>
              )}
            </>
          )}

          {workerLog.length > 0 && (
            <Card variant="surface" style={{ maxHeight: "200px", overflowY: "auto" }}>
              <Flex direction="column" gap="1">
                <Text size="2" weight="bold">Worker RPC Log:</Text>
                {workerLog.map((entry, i) => (
                  <Text key={i} size="1" style={{ fontFamily: "monospace" }}>
                    {entry}
                  </Text>
                ))}
              </Flex>
            </Card>
          )}

          <Separator size="4" />

          {/* Browser Automation Demo Section */}
          <Heading size="5">Browser Automation Demo</Heading>
          <Text size="2" color="gray">
            Demonstrates browser panel creation and automation via the Chrome DevTools Protocol (CDP).
            Launch a browser panel, then run the CDP demo to orchestrate it programmatically.
          </Text>

          <Flex gap="2" wrap="wrap" align="end">
            <Flex direction="column" gap="1" style={{ flex: 1 }}>
              <Text size="1" weight="bold">Initial URL:</Text>
              <TextField.Root
                placeholder="https://example.com"
                value={browserUrlInput}
                onChange={(e) => setBrowserUrlInput(e.target.value)}
                size="1"
              />
            </Flex>
            <Button onClick={launchBrowser} color="teal" disabled={!!browserId}>
              {browserId ? "Browser Running" : "Launch Browser"}
            </Button>
          </Flex>

          {browserId && (
            <Card variant="surface">
              <Flex direction="column" gap="3">
                <Flex align="center" gap="2">
                  <Text size="2" weight="bold">Browser Panel:</Text>
                  <Badge color="teal" style={{ fontFamily: "monospace" }}>
                    {browserId}
                  </Badge>
                </Flex>

                <Text size="2" color="gray">
                  The browser panel is running as a child. Click "Run CDP Demo" to:
                </Text>
                <Text size="1" color="gray" style={{ paddingLeft: "16px" }}>
                  • Connect via CDP WebSocket<br />
                  • Navigate to httpbin.org/html<br />
                  • Extract the page heading<br />
                  • Take a screenshot<br />
                  • Navigate to example.com
                </Text>

                <Flex gap="2" wrap="wrap">
                  <Button onClick={runPlaywrightDemo} variant="soft" color="teal">
                    Run Playwright Demo
                  </Button>
                  <Button onClick={closeBrowser} variant="soft" color="red">
                    Close Browser
                  </Button>
                </Flex>
              </Flex>
            </Card>
          )}

          {browserLog.length > 0 && (
            <Card variant="surface" style={{ maxHeight: "300px", overflowY: "auto" }}>
              <Flex direction="column" gap="1">
                <Text size="2" weight="bold">Browser Automation Log:</Text>
                {browserLog.map((entry, i) => (
                  <Text key={i} size="1" style={{ fontFamily: "monospace" }}>
                    {entry}
                  </Text>
                ))}
              </Flex>
            </Card>
          )}
        </Flex>
      </Card>
    </div>
  );
}
