/**
 * Typed RPC Child Panel
 * Exposes a typed API and emits typed events
 */

import { useState, useEffect } from "react";
import { Card, Flex, Heading, Text, Badge, Button } from "@radix-ui/themes";
import { rpc, getInfo, getParentWithContract, noopParent } from "@natstack/runtime";
import { rpcDemoContract } from "./contract.js";

// Get typed parent handle using the contract, with noopParent fallback
// This gives us type-checked emit() calls without null checks
const parent = getParentWithContract(rpcDemoContract) ?? noopParent;

// Internal state
let counter = 0;
let pingCount = 0;

export default function TypedRpcChild() {
  const [displayCounter, setDisplayCounter] = useState(counter);
  const [log, setLog] = useState<string[]>([]);

  const addLog = (message: string) => {
    const timestamp = new Date().toLocaleTimeString();
    setLog((prev) => [`[${timestamp}] ${message}`, ...prev.slice(0, 9)]);
  };

  // Expose typed RPC methods
  useEffect(() => {
    addLog("Exposing RPC API...");

    rpc.expose({
      async ping() {
        pingCount++;
        addLog(`ping() called (count: ${pingCount})`);

        // Emit typed event to parent (noop if no parent)
        parent.emit("ping-received", { count: pingCount });

        return "pong";
      },

      async echo(message: string) {
        addLog(`echo("${message}") called`);
        return `Echo: ${message}`;
      },

      async getCounter() {
        addLog(`getCounter() called, returning ${counter}`);
        return counter;
      },

      async incrementCounter(amount = 1) {
        const previousValue = counter;
        counter += amount;
        setDisplayCounter(counter);
        addLog(`incrementCounter(${amount}) called, new value: ${counter}`);

        // Emit typed event to parent (noop if no parent)
        parent.emit("counter-changed", { value: counter, previousValue });

        return counter;
      },

      async resetCounter() {
        counter = 0;
        setDisplayCounter(counter);
        addLog("resetCounter() called");

        // Emit typed event to parent (noop if no parent)
        parent.emit("reset", { timestamp: new Date().toISOString() });
      },

      async getInfo() {
        const info = await getInfo();
        addLog(`getInfo() called, panelId: ${info.panelId}`);
        return { panelId: info.panelId, counter };
      },
    });

    addLog("RPC API exposed successfully");
  }, []);

  const handleLocalIncrement = () => {
    const previousValue = counter;
    counter += 1;
    setDisplayCounter(counter);
    parent.emit("counter-changed", { value: counter, previousValue });
  };

  const handleLocalReset = () => {
    counter = 0;
    setDisplayCounter(counter);
    parent.emit("reset", { timestamp: new Date().toISOString() });
  };

  return (
    <div style={{ padding: "20px" }}>
      <Card>
        <Flex direction="column" gap="4">
          <Flex align="center" gap="3">
            <Heading size="6">Typed RPC Child</Heading>
            <Badge color="green">Exposing API</Badge>
          </Flex>

          <Text size="2" color="gray">
            This panel exposes a typed API that can be called by the parent with
            full type safety.
          </Text>

          {parent.id && (
            <Card variant="surface">
              <Text size="2">
                Parent ID: <Text weight="bold" style={{ fontFamily: "monospace" }}>{parent.id}</Text>
              </Text>
            </Card>
          )}

          <Card variant="surface">
            <Flex direction="column" gap="3">
              <Text size="2" weight="bold">Exposed API Methods:</Text>
              <Flex direction="column" gap="1">
                <Text size="1" style={{ fontFamily: "monospace" }}>
                  • ping(): Promise&lt;string&gt;
                </Text>
                <Text size="1" style={{ fontFamily: "monospace" }}>
                  • echo(message: string): Promise&lt;string&gt;
                </Text>
                <Text size="1" style={{ fontFamily: "monospace" }}>
                  • getCounter(): Promise&lt;number&gt;
                </Text>
                <Text size="1" style={{ fontFamily: "monospace" }}>
                  • incrementCounter(amount?: number): Promise&lt;number&gt;
                </Text>
                <Text size="1" style={{ fontFamily: "monospace" }}>
                  • resetCounter(): Promise&lt;void&gt;
                </Text>
              </Flex>
            </Flex>
          </Card>

          <Card variant="surface">
            <Flex direction="column" gap="3">
              <Text size="2" weight="bold">Emitted Events:</Text>
              <Flex direction="column" gap="1">
                <Text size="1" style={{ fontFamily: "monospace" }}>
                  • "counter-changed": {"{"} value, previousValue {"}"}
                </Text>
                <Text size="1" style={{ fontFamily: "monospace" }}>
                  • "reset": {"{"} timestamp {"}"}
                </Text>
                <Text size="1" style={{ fontFamily: "monospace" }}>
                  • "ping-received": {"{"} count {"}"}
                </Text>
              </Flex>
            </Flex>
          </Card>

          <Card variant="surface">
            <Flex direction="column" gap="3">
              <Flex align="center" gap="2">
                <Text size="2" weight="bold">Counter Value:</Text>
                <Badge size="3" color="blue">{displayCounter}</Badge>
              </Flex>
              <Flex gap="2">
                <Button onClick={handleLocalIncrement} size="2">
                  Local Increment
                </Button>
                <Button onClick={handleLocalReset} variant="soft" size="2" color="red">
                  Local Reset
                </Button>
              </Flex>
              <Text size="1" color="gray">
                Local changes emit events to parent
              </Text>
            </Flex>
          </Card>

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
