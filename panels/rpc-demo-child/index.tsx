import React, { useState, useEffect, useCallback } from "react";
import { Theme, Button, Card, Flex, Text, Heading, Callout, Badge, TextField } from "@radix-ui/themes";
import panelAPI, { createReactPanelMount } from "natstack/react";
import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import "./style.css";

const mount = createReactPanelMount(React, createRoot, { ThemeComponent: Theme });

// =============================================================================
// Define the RPC API this child panel exposes
// =============================================================================

// Type definition for the exposed API (can be shared with parent for type safety)
export interface RpcDemoChildApi {
  ping(): Promise<string>;
  echo(message: string): Promise<string>;
  getCounter(): Promise<number>;
  incrementCounter(amount?: number): Promise<number>;
  resetCounter(): Promise<void>;
  getInfo(): Promise<{ panelId: string; createdAt: string }>;
}

// Internal state for the child panel
let counter = 0;
const createdAt = new Date().toISOString();

function RpcDemoChild() {
  const [theme, setTheme] = useState(panelAPI.getTheme().appearance);
  const [log, setLog] = useState<string[]>([]);
  const [displayCounter, setDisplayCounter] = useState(counter);
  const [eventMessage, setEventMessage] = useState("");

  const parentId = process.env.PARENT_ID;

  const addLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLog((prev) => [`[${timestamp}] ${message}`, ...prev.slice(0, 19)]);
  }, []);

  useEffect(() => {
    return panelAPI.onThemeChange(({ appearance }) => setTheme(appearance));
  }, []);

  // Expose RPC methods when component mounts
  useEffect(() => {
    addLog("Exposing RPC methods...");

    panelAPI.rpc.expose({
      // Simple ping-pong
      async ping() {
        addLog("RPC: ping() called");
        return "pong";
      },

      // Echo back a message
      async echo(message: string) {
        addLog(`RPC: echo("${message}") called`);
        return `Echo: ${message}`;
      },

      // Get current counter value
      async getCounter() {
        addLog(`RPC: getCounter() called, returning ${counter}`);
        return counter;
      },

      // Increment counter and return new value
      async incrementCounter(amount = 1) {
        counter += amount;
        setDisplayCounter(counter);
        addLog(`RPC: incrementCounter(${amount}) called, new value: ${counter}`);
        return counter;
      },

      // Reset counter to zero
      async resetCounter() {
        counter = 0;
        setDisplayCounter(counter);
        addLog("RPC: resetCounter() called");
      },

      // Get panel info
      async getInfo() {
        addLog("RPC: getInfo() called");
        return {
          panelId: panelAPI.getId(),
          createdAt,
        };
      },
    });

    addLog("RPC methods exposed successfully");
  }, [addLog]);

  // Listen for events from parent
  useEffect(() => {
    const unsubscribe = panelAPI.rpc.onEvent("parentMessage", (fromPanelId, payload) => {
      addLog(`Event received from ${fromPanelId}: ${JSON.stringify(payload)}`);
    });

    return unsubscribe;
  }, [addLog]);

  const sendEventToParent = () => {
    if (!parentId) {
      addLog("Cannot send event: no parent ID");
      return;
    }

    const payload = {
      message: eventMessage || "Hello from child!",
      counter: displayCounter,
      timestamp: new Date().toISOString(),
    };

    panelAPI.rpc.emit(parentId, "childUpdate", payload);
    addLog(`Sent 'childUpdate' event to parent: ${JSON.stringify(payload)}`);
  };

  return (
    <div style={{ padding: "20px" }}>
      <Card size="3" style={{ width: "100%" }}>
        <Flex direction="column" gap="4">
          <Flex align="center" gap="3">
            <Heading size="6">RPC Demo Child</Heading>
            <Badge color="green">Child Panel</Badge>
          </Flex>

          <Text size="2">
            Panel ID: <Text weight="bold" style={{ fontFamily: "monospace" }}>{panelAPI.getId()}</Text>
          </Text>

          {parentId && (
            <Text size="2">
              Parent ID: <Text weight="bold" style={{ fontFamily: "monospace" }}>{parentId}</Text>
            </Text>
          )}

          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">Exposed RPC Methods:</Text>
              <Text size="1" color="gray" style={{ fontFamily: "monospace" }}>
                • ping() → "pong"
              </Text>
              <Text size="1" color="gray" style={{ fontFamily: "monospace" }}>
                • echo(message) → "Echo: " + message
              </Text>
              <Text size="1" color="gray" style={{ fontFamily: "monospace" }}>
                • getCounter() → number
              </Text>
              <Text size="1" color="gray" style={{ fontFamily: "monospace" }}>
                • incrementCounter(amount?) → number
              </Text>
              <Text size="1" color="gray" style={{ fontFamily: "monospace" }}>
                • resetCounter() → void
              </Text>
              <Text size="1" color="gray" style={{ fontFamily: "monospace" }}>
                • getInfo() → {"{"} panelId, createdAt {"}"}
              </Text>
            </Flex>
          </Card>

          <Card variant="surface">
            <Flex direction="column" gap="2">
              <Text size="2" weight="bold">
                Counter Value: <Badge size="2" color="blue">{displayCounter}</Badge>
              </Text>
              <Text size="1" color="gray">
                This counter is modified by parent RPC calls.
              </Text>
            </Flex>
          </Card>

          {parentId && (
            <Card variant="surface">
              <Flex direction="column" gap="2">
                <Text size="2" weight="bold">Send Event to Parent</Text>
                <Flex gap="2">
                  <TextField.Root
                    placeholder="Message to send..."
                    value={eventMessage}
                    onChange={(e) => setEventMessage(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <Button onClick={sendEventToParent} color="green">
                    Send Event
                  </Button>
                </Flex>
              </Flex>
            </Card>
          )}

          <Card variant="surface" style={{ maxHeight: "200px", overflowY: "auto" }}>
            <Flex direction="column" gap="1">
              <Text size="2" weight="bold">Activity Log</Text>
              {log.length === 0 ? (
                <Text size="1" color="gray">No activity yet...</Text>
              ) : (
                log.map((entry, i) => (
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

mount(RpcDemoChild);
