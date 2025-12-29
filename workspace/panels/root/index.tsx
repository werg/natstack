import { useState, useCallback, useEffect } from "react";
import { promises as fsPromises } from "fs";
import { Button, Card, Flex, Text, Heading, Callout, Separator, Badge, TextField } from "@radix-ui/themes";
import { createChild, createChildWithContract, setTitle, type ChildHandle, type ChildHandleFromContract } from "@natstack/runtime";
import {
  usePanelTheme,
  usePanelId,
  usePanelPartition,
  usePanelChildren,
} from "@natstack/react";
import "./style.css";

import { rpcDemoContract } from "../typed-rpc-child/contract.js";
import { rpcExampleWorkerContract } from "../../workers/rpc-example/contract.js";

export default function ChildPanelLauncher() {
  const [status, setStatus] = useState<string>("");
  const theme = usePanelTheme();
  const panelId = usePanelId();
  const partition = usePanelPartition();
  const env = process.env;
  const children = usePanelChildren();

  const [opfsStatus, setOpfsStatus] = useState<string>("");
  const [opfsContent, setOpfsContent] = useState<string>("");

  // RPC Demo state - using contract-derived ChildHandle type
  const [rpcChild, setRpcChild] = useState<ChildHandleFromContract<typeof rpcDemoContract> | null>(null);
  const [rpcLog, setRpcLog] = useState<string[]>([]);
  const [echoInput, setEchoInput] = useState("");
  const [incrementAmount, setIncrementAmount] = useState("1");
  const [childEvents, setChildEvents] = useState<string[]>([]);

  // Worker RPC Demo state - using contract-derived ChildHandle type
  const [worker, setWorker] = useState<ChildHandleFromContract<typeof rpcExampleWorkerContract> | null>(null);
  const [workerLog, setWorkerLog] = useState<string[]>([]);
  const [workerEchoInput, setWorkerEchoInput] = useState("");
  const [workerIncrementAmount, setWorkerIncrementAmount] = useState("1");
  const [workerSumInput, setWorkerSumInput] = useState("1, 2, 3, 4, 5");
  const [workerEvents, setWorkerEvents] = useState<string[]>([]);

  // Browser Automation Demo state - using ChildHandle directly
  const [browser, setBrowser] = useState<ChildHandle | null>(null);
  const [browserLog, setBrowserLog] = useState<string[]>([]);
  const [browserUrlInput, setBrowserUrlInput] = useState("https://example.com");
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);

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

  // Subscribe to events from the RPC child using handle.onEvent
  useEffect(() => {
    if (!rpcChild) return;
    const unsubscribe = rpcChild.onEvent("counter-changed", (payload) => {
      const timestamp = new Date().toLocaleTimeString();
      setChildEvents((prev) => [
        `[${timestamp}] counter-changed: ${JSON.stringify(payload)}`,
        ...prev.slice(0, 4),
      ]);
    });
    return unsubscribe;
  }, [rpcChild]);

  // Subscribe to events from the worker using handle.onEvents batch API
  useEffect(() => {
    if (!worker) return;

    return worker.onEvents({
      "counter-changed": (payload) => {
        const timestamp = new Date().toLocaleTimeString();
        setWorkerEvents((prev) => [
          `[${timestamp}] counter-changed: ${JSON.stringify(payload)}`,
          ...prev.slice(0, 4),
        ]);
      },
      "ping-received": (payload) => {
        const timestamp = new Date().toLocaleTimeString();
        setWorkerEvents((prev) => [
          `[${timestamp}] ping-received: ${JSON.stringify(payload)}`,
          ...prev.slice(0, 4),
        ]);
      },
      "reset": (payload) => {
        const timestamp = new Date().toLocaleTimeString();
        setWorkerEvents((prev) => [
          `[${timestamp}] reset: ${JSON.stringify(payload)}`,
          ...prev.slice(0, 4),
        ]);
      },
    });
  }, [worker]);

  // Get env variables that were passed from parent
  const parentId = env.PARENT_ID;
  const launchTime = env.LAUNCH_TIME;
  const message = env.MESSAGE;

  const launchChildPanel = async () => {
    try {
      setStatus("Launching child panel...");
      const child = await createChild({
        type: "app",
        name: "another-root",
        source: "panels/root",
        env: {
          PARENT_ID: panelId,
          LAUNCH_TIME: new Date().toISOString(),
          MESSAGE: "Hello from parent panel!",
        },
      });
      setStatus(`Launched child: ${child.name} (${child.id})`);
    } catch (error) {
      setStatus(`Failed to launch child: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const launchSharedOPFSDemo = async () => {
    try {
      setStatus("Launching shared OPFS demo panel...");
      const child = await createChild({
        type: "app",
        source: "panels/shared-opfs-demo",
      });
      setStatus(`Launched shared OPFS demo: ${child.name}`);
    } catch (error) {
      setStatus(`Failed to launch: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const launchAgenticChat = async () => {
    try {
      setStatus("Launching agentic chat example...");
      const child = await createChild({
        type: "app",
        name: "agentic-chat",
        source: "panels/agentic-chat",
      });
      setStatus(`Launched agentic chat: ${child.name}`);
    } catch (error) {
      setStatus(`Failed to launch agentic chat: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const launchPubSubChatDemo = async () => {
    try {
      setStatus("Launching PubSub chat demo...");
      const child = await createChild({
        type: "app",
        name: "pubsub-chat-demo",
        source: "panels/pubsub-chat",
      });
      setStatus(`Launched PubSub chat: ${child.name}`);
    } catch (error) {
      setStatus(`Failed to launch: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const launchAgentManager = async () => {
    try {
      setStatus("Launching Agent Manager...");
      const child = await createChild({
        type: "app",
        name: "agent-manager",
        source: "panels/agent-manager",
      });
      setStatus(`Launched Agent Manager: ${child.name}`);
    } catch (error) {
      setStatus(`Failed to launch Agent Manager: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const setRandomTitle = async () => {
    const title = `Radix Panel ${Math.floor(Math.random() * 1000)}`;
    await setTitle(title);
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
  // RPC Demo Functions - Using ChildHandle API
  // ===========================================================================

  const launchRpcDemoChild = async () => {
    try {
      addRpcLog("Launching RPC demo child panel...");
      // Use the contract-based API for full type safety
      const child = await createChildWithContract(rpcDemoContract, {
        name: "typed-rpc-child",
        env: { PARENT_ID: panelId },
      });
      setRpcChild(child);
      addRpcLog(`Child panel launched: ${child.name} (${child.id})`);
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const callPing = async () => {
    if (!rpcChild) {
      addRpcLog("No child panel connected");
      return;
    }
    try {
      addRpcLog("Calling ping()...");
      const result = await rpcChild.call.ping();
      addRpcLog(`Result: "${result}"`);
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const callEcho = async () => {
    if (!rpcChild) {
      addRpcLog("No child panel connected");
      return;
    }
    try {
      const msg = echoInput || "Hello!";
      addRpcLog(`Calling echo("${msg}")...`);
      const result = await rpcChild.call.echo(msg);
      addRpcLog(`Result: "${result}"`);
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const callGetCounter = async () => {
    if (!rpcChild) {
      addRpcLog("No child panel connected");
      return;
    }
    try {
      addRpcLog("Calling getCounter()...");
      const result = await rpcChild.call.getCounter();
      addRpcLog(`Result: ${result}`);
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const callIncrementCounter = async () => {
    if (!rpcChild) {
      addRpcLog("No child panel connected");
      return;
    }
    try {
      const amount = parseInt(incrementAmount) || 1;
      addRpcLog(`Calling incrementCounter(${amount})...`);
      const result = await rpcChild.call.incrementCounter(amount);
      addRpcLog(`Result: ${result}`);
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const callResetCounter = async () => {
    if (!rpcChild) {
      addRpcLog("No child panel connected");
      return;
    }
    try {
      addRpcLog("Calling resetCounter()...");
      await rpcChild.call.resetCounter();
      addRpcLog("Counter reset successfully");
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const callGetInfo = async () => {
    if (!rpcChild) {
      addRpcLog("No child panel connected");
      return;
    }
    try {
      addRpcLog("Calling getInfo()...");
      const result = await rpcChild.call.getInfo();
      addRpcLog(`Result: ${JSON.stringify(result)}`);
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const sendEventToChild = async () => {
    if (!rpcChild) {
      addRpcLog("No child panel connected");
      return;
    }
    const payload = { message: "Hello from parent!", timestamp: new Date().toISOString() };
    await rpcChild.emit("parentMessage", payload);
    addRpcLog(`Sent 'parentMessage' event: ${JSON.stringify(payload)}`);
  };

  const closeRpcChild = async () => {
    if (!rpcChild) return;
    try {
      addRpcLog(`Closing ${rpcChild.name}...`);
      await rpcChild.close();
      setRpcChild(null);
      setChildEvents([]);
      addRpcLog("Child closed");
    } catch (error) {
      addRpcLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // ===========================================================================
  // Worker RPC Demo Functions - Using ChildHandle API
  // ===========================================================================

  const launchRpcWorker = async () => {
    try {
      addWorkerLog("Launching RPC example worker...");
      // Use the contract-based API for full type safety
      const w = await createChildWithContract(rpcExampleWorkerContract, {
        name: "rpc-example-worker",
        env: { PARENT_ID: panelId },
        type: "worker",
      });
      setWorker(w);
      addWorkerLog(`Worker launched: ${w.name} (${w.id})`);
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCallPing = async () => {
    if (!worker) {
      addWorkerLog("No worker connected");
      return;
    }
    try {
      addWorkerLog("Calling ping()...");
      const result = await worker.call.ping();
      addWorkerLog(`Result: "${result}"`);
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCallEcho = async () => {
    if (!worker) {
      addWorkerLog("No worker connected");
      return;
    }
    try {
      const msg = workerEchoInput || "Hello from panel!";
      addWorkerLog(`Calling echo("${msg}")...`);
      const result = await worker.call.echo(msg);
      addWorkerLog(`Result: "${result}"`);
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCallGetCounter = async () => {
    if (!worker) {
      addWorkerLog("No worker connected");
      return;
    }
    try {
      addWorkerLog("Calling getCounter()...");
      const result = await worker.call.getCounter();
      addWorkerLog(`Result: ${result}`);
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCallIncrementCounter = async () => {
    if (!worker) {
      addWorkerLog("No worker connected");
      return;
    }
    try {
      const amount = parseInt(workerIncrementAmount) || 1;
      addWorkerLog(`Calling incrementCounter(${amount})...`);
      const result = await worker.call.incrementCounter(amount);
      addWorkerLog(`Result: ${result}`);
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCallResetCounter = async () => {
    if (!worker) {
      addWorkerLog("No worker connected");
      return;
    }
    try {
      addWorkerLog("Calling resetCounter()...");
      await worker.call.resetCounter();
      addWorkerLog("Counter reset successfully");
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCallGetInfo = async () => {
    if (!worker) {
      addWorkerLog("No worker connected");
      return;
    }
    try {
      addWorkerLog("Calling getWorkerInfo()...");
      const result = await worker.call.getWorkerInfo();
      addWorkerLog(`Result: ${JSON.stringify(result)}`);
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const workerCallComputeSum = async () => {
    if (!worker) {
      addWorkerLog("No worker connected");
      return;
    }
    try {
      const numbers = workerSumInput.split(",").map((s) => parseFloat(s.trim())).filter((n) => !isNaN(n));
      addWorkerLog(`Calling computeSum([${numbers.join(", ")}])...`);
      const result = await worker.call.computeSum(numbers);
      addWorkerLog(`Result: ${result}`);
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const sendEventToWorker = async () => {
    if (!worker) {
      addWorkerLog("No worker connected");
      return;
    }
    const payload = { message: "Hello from panel!", timestamp: new Date().toISOString() };
    await worker.emit("parentMessage", payload);
    addWorkerLog(`Sent 'parentMessage' event: ${JSON.stringify(payload)}`);
  };

  const closeWorker = async () => {
    if (!worker) return;
    try {
      addWorkerLog(`Closing ${worker.name}...`);
      await worker.close();
      setWorker(null);
      setWorkerEvents([]);
      addWorkerLog("Worker closed");
    } catch (error) {
      addWorkerLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // ===========================================================================
  // Browser Automation Demo Functions - Using ChildHandle API
  // ===========================================================================

  const launchBrowser = async () => {
    try {
      addBrowserLog("Launching browser panel...");
      const b = await createChild({
        type: "browser",
        name: "demo-browser",
        source: browserUrlInput,
        title: "Demo Browser",
      });
      setBrowser(b);
      addBrowserLog(`Browser launched: ${b.name} (${b.id})`);
    } catch (error) {
      addBrowserLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const runPlaywrightDemo = async () => {
    if (!browser) {
      addBrowserLog("No browser launched - launch one first!");
      return;
    }

    addBrowserLog("Starting CDP automation on browser panel...");

    try {
      const { BrowserImpl } = await import("@natstack/playwright-core");

      addBrowserLog("Getting CDP endpoint...");
      // Use ChildHandle's getCdpEndpoint method directly
      const cdpUrl = await browser.getCdpEndpoint();
      addBrowserLog(`CDP endpoint obtained`);

      addBrowserLog("Connecting to browser via BrowserImpl...");
      const browserConn = await BrowserImpl.connect(cdpUrl);
      addBrowserLog(`Connected! Browser version: ${browserConn.version()}`);

      const context = browserConn.defaultContext();
      if (!context) {
        addBrowserLog("No default context available");
        return;
      }

      addBrowserLog("Getting page...");
      let pages = context.pages();
      let page = pages[0];
      if (!page) {
        addBrowserLog("Creating new page...");
        page = await context.newPage();
      }
      addBrowserLog(`Got page, current URL: ${page.url()}`);

      addBrowserLog("Navigating to https://example.com...");
      await page.goto("https://example.com", { waitUntil: "load" });
      addBrowserLog("Page loaded");

      const title = await page.title();
      addBrowserLog(`Page title: "${title}"`);

      addBrowserLog("Extracting h1 content...");
      const h1Text = await page.evaluate(() => {
        const h1 = document.querySelector("h1");
        return h1 ? h1.textContent : null;
      });
      if (h1Text) {
        addBrowserLog(`Found h1: "${h1Text.trim()}"`);
      } else {
        addBrowserLog("No h1 found on page");
      }

      addBrowserLog("Analyzing page structure...");
      const headings = await page.evaluate(() => {
        const els = document.querySelectorAll("h1, h2, h3, h4, h5, h6");
        return Array.from(els).map(el => ({
          tag: el.tagName.toLowerCase(),
          text: el.textContent?.trim() || "",
        }));
      }) as { tag: string; text: string }[];
      addBrowserLog(`Found ${headings.length} heading(s)`);
      for (let i = 0; i < Math.min(headings.length, 3); i++) {
        const heading = headings[i];
        addBrowserLog(`  ${heading.tag}: "${heading.text}"`);
      }

      addBrowserLog("Taking screenshot via CDP...");
      try {
        const screenshotData = await page.screenshot({ format: "png" });
        addBrowserLog(`Screenshot captured: ${screenshotData.length} bytes`);

        let binary = "";
        const bytes = new Uint8Array(screenshotData);
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        const dataUrl = `data:image/png;base64,${base64}`;
        setScreenshotDataUrl(dataUrl);
        addBrowserLog("Screenshot saved for display");
      } catch (screenshotError) {
        addBrowserLog(`Screenshot failed: ${screenshotError instanceof Error ? screenshotError.message : String(screenshotError)}`);
      }

      addBrowserLog("Evaluating JavaScript...");
      const pageInfo = await page.evaluate(() => ({
        url: window.location.href,
        title: document.title,
        elementCount: document.querySelectorAll("*").length,
        linkCount: document.querySelectorAll("a").length,
      }));
      addBrowserLog(`Page stats: ${JSON.stringify(pageInfo)}`);

      addBrowserLog("Testing selector operations...");
      const hasMoreLink = await page.querySelector("a[href]");
      if (hasMoreLink) {
        addBrowserLog("✓ Found link element");
      }

      addBrowserLog("Closing browser connection...");
      await browserConn.close();

      addBrowserLog("✅ BrowserImpl automation demo complete!");
    } catch (error) {
      addBrowserLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
      console.error("Playwright demo error:", error);
    }
  };

  const closeBrowser = async () => {
    if (!browser) {
      addBrowserLog("No browser to close");
      return;
    }
    try {
      addBrowserLog(`Closing browser ${browser.name}...`);
      // Use ChildHandle's close method directly
      await browser.close();
      setBrowser(null);
      addBrowserLog("Browser closed");
    } catch (error) {
      addBrowserLog(`Error: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  // Use browser's navigate method via the handle
  const navigateBrowser = async (url: string) => {
    if (!browser) return;
    try {
      addBrowserLog(`Navigating to ${url}...`);
      await browser.navigate(url);
      addBrowserLog("Navigation complete");
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
            <Badge color="violet">
              Children: {children.size}
            </Badge>
          </Flex>
          <Text size="2">
            Current theme: <Text weight="bold">{theme}</Text>
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
            <Button onClick={launchPubSubChatDemo} color="cyan">
              Launch PubSub Chat Demo
            </Button>
            <Button onClick={launchAgentManager} color="orange">
              Launch Agent Manager
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
          <Heading size="5">Panel-to-Panel RPC Demo (ChildHandle API)</Heading>
          <Text size="2" color="gray">
            Demonstrates typed RPC communication between parent and child panels using the unified ChildHandle API.
            All operations go through the handle: <code>child.call.*</code>, <code>child.emit()</code>, <code>child.onEvent()</code>, <code>child.close()</code>.
          </Text>

          <Flex gap="2" wrap="wrap">
            <Button onClick={launchRpcDemoChild} color="cyan" disabled={!!rpcChild}>
              {rpcChild ? "Child Connected" : "Launch RPC Demo Child"}
            </Button>
            {rpcChild && (
              <Button onClick={closeRpcChild} variant="soft" color="red">
                Close Child
              </Button>
            )}
          </Flex>

          {rpcChild && (
            <>
              <Card variant="surface">
                <Flex direction="column" gap="3">
                  <Flex align="center" gap="2">
                    <Text size="2" weight="bold">Connected to:</Text>
                    <Badge color="green" style={{ fontFamily: "monospace" }}>
                      {rpcChild.name}
                    </Badge>
                    <Text size="1" color="gray">({rpcChild.type})</Text>
                  </Flex>

                  <Text size="2" weight="bold">Call Methods via <code>child.call.*</code>:</Text>
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

                  <Text size="2" weight="bold">Events via <code>child.emit()</code>:</Text>
                  <Button onClick={sendEventToChild} variant="soft" size="1" color="orange">
                    Send "parentMessage" Event to Child
                  </Button>
                </Flex>
              </Card>

              {childEvents.length > 0 && (
                <Card variant="surface">
                  <Flex direction="column" gap="1">
                    <Text size="2" weight="bold">Events from Child (via <code>child.onEvent()</code>):</Text>
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
          <Heading size="5">Worker RPC Demo (ChildHandle API)</Heading>
          <Text size="2" color="gray">
            Demonstrates RPC communication between a panel and an isolated worker using the unified ChildHandle API.
            Workers run in a sandboxed environment with their own filesystem.
          </Text>

          <Flex gap="2" wrap="wrap">
            <Button onClick={launchRpcWorker} color="orange" disabled={!!worker}>
              {worker ? "Worker Connected" : "Launch RPC Example Worker"}
            </Button>
            {worker && (
              <Button onClick={closeWorker} variant="soft" color="red">
                Close Worker
              </Button>
            )}
          </Flex>

          {worker && (
            <>
              <Card variant="surface">
                <Flex direction="column" gap="3">
                  <Flex align="center" gap="2">
                    <Text size="2" weight="bold">Connected to:</Text>
                    <Badge color="orange" style={{ fontFamily: "monospace" }}>
                      {worker.name}
                    </Badge>
                    <Text size="1" color="gray">({worker.type})</Text>
                  </Flex>

                  <Text size="2" weight="bold">Call Methods via <code>worker.call.*</code>:</Text>
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

                  <Text size="2" weight="bold">Events via <code>worker.emit()</code>:</Text>
                  <Button onClick={sendEventToWorker} variant="soft" size="1" color="orange">
                    Send "parentMessage" Event to Worker
                  </Button>
                </Flex>
              </Card>

              {workerEvents.length > 0 && (
                <Card variant="surface">
                  <Flex direction="column" gap="1">
                    <Text size="2" weight="bold">Events from Worker (via <code>worker.onEvent()</code>):</Text>
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
          <Heading size="5">Browser Automation Demo (ChildHandle API)</Heading>
          <Text size="2" color="gray">
            Demonstrates browser panel creation and automation via the Chrome DevTools Protocol (CDP).
            Uses <code>browser.getCdpEndpoint()</code>, <code>browser.navigate()</code>, and <code>browser.close()</code> from the handle.
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
            <Button onClick={launchBrowser} color="teal" disabled={!!browser}>
              {browser ? "Browser Running" : "Launch Browser"}
            </Button>
          </Flex>

          {browser && (
            <Card variant="surface">
              <Flex direction="column" gap="3">
                <Flex align="center" gap="2">
                  <Text size="2" weight="bold">Browser Panel:</Text>
                  <Badge color="teal" style={{ fontFamily: "monospace" }}>
                    {browser.name}
                  </Badge>
                  <Text size="1" color="gray">({browser.type})</Text>
                </Flex>

                <Text size="2" color="gray">
                  The browser panel is running as a child. Click "Run CDP Demo" to:
                </Text>
                <Text size="1" color="gray" style={{ paddingLeft: "16px" }}>
                  • Connect via CDP WebSocket using <code>browser.getCdpEndpoint()</code><br />
                  • Navigate to example.com<br />
                  • Extract page title and headings<br />
                  • Take a screenshot<br />
                  • Evaluate JavaScript on page
                </Text>

                <Flex gap="2" wrap="wrap">
                  <Button onClick={runPlaywrightDemo} variant="soft" color="teal">
                    Run Playwright Demo
                  </Button>
                  <Button onClick={() => navigateBrowser("https://google.com")} variant="soft">
                    Navigate to Google
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

          {screenshotDataUrl && (
            <Card variant="surface">
              <Flex direction="column" gap="2">
                <Flex justify="between" align="center">
                  <Text size="2" weight="bold">Screenshot:</Text>
                  <Button
                    variant="soft"
                    size="1"
                    color="red"
                    onClick={() => setScreenshotDataUrl(null)}
                  >
                    Clear
                  </Button>
                </Flex>
                <img
                  src={screenshotDataUrl}
                  alt="Browser Screenshot"
                  style={{
                    maxWidth: "100%",
                    border: "1px solid var(--gray-6)",
                    borderRadius: "4px",
                  }}
                />
              </Flex>
            </Card>
          )}

          <Separator size="4" />

          {/* Children Overview Section */}
          <Heading size="5">Active Children (via <code>usePanelChildren()</code>)</Heading>
          <Text size="2" color="gray">
            Displays all children tracked by the panel API. Uses the <code>usePanelChildren()</code> hook for reactive updates.
          </Text>

          {children.size === 0 ? (
            <Callout.Root color="gray">
              <Callout.Text>No children currently active. Launch a child above to see it here.</Callout.Text>
            </Callout.Root>
          ) : (
            <Card variant="surface">
              <Flex direction="column" gap="2">
                {[...children.entries()].map(([name, handle]) => (
                  <Flex key={handle.id} justify="between" align="center">
                    <Flex gap="2" align="center">
                      <Badge color={handle.type === "app" ? "cyan" : handle.type === "worker" ? "orange" : "teal"}>
                        {handle.type}
                      </Badge>
                      <Text size="2" weight="bold">{name}</Text>
                      <Text size="1" color="gray" style={{ fontFamily: "monospace" }}>
                        {handle.id}
                      </Text>
                    </Flex>
                    <Button
                      variant="soft"
                      size="1"
                      color="red"
                      onClick={() => handle.close()}
                    >
                      Close
                    </Button>
                  </Flex>
                ))}
              </Flex>
            </Card>
          )}
        </Flex>
      </Card>
    </div>
  );
}
