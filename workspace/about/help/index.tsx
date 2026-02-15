/**
 * Help Page - Shell panel showing documentation and help resources.
 */

import { createRoot } from "react-dom/client";
import "@radix-ui/themes/styles.css";
import { Theme, Card, Flex, Heading, Text, Box, Link, ScrollArea } from "@radix-ui/themes";
import { usePanelTheme } from "@workspace/react";

interface HelpSection {
  title: string;
  content: string;
  links?: Array<{ label: string; url: string }>;
}

const helpSections: HelpSection[] = [
  {
    title: "Getting Started",
    content:
      "NatStack is a composable desktop application framework that lets you build and run panels. " +
      "Panels are self-contained web applications that can communicate with each other and access system services.",
  },
  {
    title: "Workspaces",
    content:
      "A workspace is a directory containing your panels and configuration. " +
      "Each workspace has a natstack.yml file that defines settings like the git server port. " +
      "Use Cmd/Ctrl+Shift+O to switch between workspaces.",
  },
  {
    title: "Panels",
    content:
      "Panels are React applications that run in isolated webviews. They can be app panels (your code), " +
      "browser panels (external websites), or worker panels (background processes). " +
      "Panels can create child panels and communicate via RPC.",
  },
  {
    title: "AI Integration",
    content:
      "NatStack supports multiple AI providers including OpenAI, Anthropic, Google, and more. " +
      "Configure your API keys in Model Provider Config (Cmd/Ctrl+Shift+M) to enable AI features in your panels.",
  },
  {
    title: "Development",
    content:
      "Use the DevTools (Cmd/Ctrl+Shift+I for panels, Cmd/Ctrl+Alt+I for the shell) to debug your applications. " +
      "Panels are hot-reloaded when you make changes to the source code.",
  },
];

function HelpPage() {
  return (
    <Box p="4" style={{ maxWidth: "800px", margin: "0 auto" }}>
      <Heading size="7" mb="4">Help & Documentation</Heading>

      <ScrollArea style={{ height: "calc(100vh - 100px)" }}>
        <Flex direction="column" gap="4">
          {helpSections.map((section) => (
            <Card key={section.title}>
              <Heading size="4" mb="2">{section.title}</Heading>
              <Text size="2" color="gray" style={{ lineHeight: 1.6 }}>
                {section.content}
              </Text>
              {section.links && (
                <Flex gap="3" mt="3">
                  {section.links.map((link) => (
                    <Link key={link.label} href={link.url} target="_blank" size="2">
                      {link.label}
                    </Link>
                  ))}
                </Flex>
              )}
            </Card>
          ))}

          <Card>
            <Heading size="4" mb="2">Need More Help?</Heading>
            <Flex direction="column" gap="2">
              <Text size="2" color="gray">
                Check the keyboard shortcuts (Cmd/Ctrl+/) for quick reference.
              </Text>
              <Text size="2" color="gray">
                Open Model Provider Config (Cmd/Ctrl+Shift+M) to configure AI providers.
              </Text>
            </Flex>
          </Card>
        </Flex>
      </ScrollArea>
    </Box>
  );
}

function ThemedApp() {
  const theme = usePanelTheme();
  return (
    <Theme appearance={theme} radius="medium">
      <HelpPage />
    </Theme>
  );
}

// Mount the app
const root = document.getElementById("root");
if (root) {
  createRoot(root).render(<ThemedApp />);
}
