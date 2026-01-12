/**
 * About Page - Shell panel showing application information.
 */

import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import { Theme, Card, Flex, Heading, Text, Box, Link } from "@radix-ui/themes";
import { rpc } from "@natstack/runtime";
import type { AppInfo } from "../../shared/ipc/types.js";

function AboutPage() {
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);

  useEffect(() => {
    rpc.call<AppInfo>("main", "app.getInfo").then(setAppInfo).catch(console.error);
  }, []);

  return (
    <Flex align="center" justify="center" style={{ height: "100vh" }}>
      <Card size="3" style={{ maxWidth: "400px", textAlign: "center" }}>
        <Flex direction="column" align="center" gap="4">
          <Box
            style={{
              width: "80px",
              height: "80px",
              borderRadius: "16px",
              background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Text size="8" style={{ color: "white", fontWeight: "bold" }}>N</Text>
          </Box>

          <Heading size="6">NatStack</Heading>

          <Text color="gray">
            A composable desktop application framework
          </Text>

          {appInfo && (
            <Text size="2" color="gray">
              Version {appInfo.version}
            </Text>
          )}

          <Flex direction="column" gap="1" mt="2">
            <Text size="2">
              Built with{" "}
              <Link href="https://electronjs.org" target="_blank">Electron</Link>,{" "}
              <Link href="https://react.dev" target="_blank">React</Link>, and{" "}
              <Link href="https://radix-ui.com" target="_blank">Radix UI</Link>
            </Text>
          </Flex>

          <Text size="1" color="gray" mt="4">
            Copyright 2024-2025 NatStack Contributors
          </Text>
        </Flex>
      </Card>
    </Flex>
  );
}

// Get theme from preload globals (passed via --natstack-theme arg)
declare const __natstackInitialTheme: "light" | "dark" | undefined;
const initialTheme = typeof __natstackInitialTheme !== "undefined" ? __natstackInitialTheme : "dark";

// Mount the app
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <Theme appearance={initialTheme} radius="medium">
      <AboutPage />
    </Theme>
  );
}
