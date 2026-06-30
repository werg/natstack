/**
 * Help Page - Shell panel showing documentation and help resources.
 */
import type { ReactNode } from "react";
import { Card, Flex, Heading, Text, Kbd } from "@radix-ui/themes";
import {
  RocketIcon,
  CubeIcon,
  DashboardIcon,
  MagicWandIcon,
  CodeIcon,
  QuestionMarkCircledIcon,
} from "@radix-ui/react-icons";
import { useIsMobile } from "@workspace/react";
import { AboutThemeRoot, AboutPage, BRAND_GRADIENT } from "@workspace/about-shared/ui";

interface HelpSection {
  title: string;
  icon: ReactNode;
  content: string;
}

const helpSections: HelpSection[] = [
  {
    title: "Getting Started",
    icon: <RocketIcon />,
    content:
      "NatStack is a composable desktop application framework that lets you build and run panels. " +
      "Panels are self-contained web applications that can communicate with each other and access system services.",
  },
  {
    title: "Workspaces",
    icon: <CubeIcon />,
    content:
      "A workspace is a directory containing your panels and configuration. " +
      "Each workspace has a meta/natstack.yml file that defines settings like initial panels and shared git remotes. " +
      "Use Cmd/Ctrl+Shift+O to switch between workspaces.",
  },
  {
    title: "Panels",
    icon: <DashboardIcon />,
    content:
      "Panels are React applications that run in isolated webviews. They can be app panels (your code) " +
      "or browser panels (external websites). " +
      "Panels can create child panels and communicate via RPC.",
  },
  {
    title: "AI Integration",
    icon: <MagicWandIcon />,
    content:
      "NatStack supports multiple AI providers including Anthropic, OpenAI, Google, and more. " +
      "Open a chat panel (Cmd/Ctrl+T, then start a chat) to work with an AI agent inside your workspace.",
  },
  {
    title: "Development",
    icon: <CodeIcon />,
    content:
      "Use the DevTools (Cmd/Ctrl+Shift+I for panels, Cmd/Ctrl+Alt+I for the shell) to debug your applications. " +
      "Panels are hot-reloaded when you make changes to the source code.",
  },
];

function SectionIcon({ children }: { children: ReactNode }) {
  return (
    <Flex
      align="center"
      justify="center"
      style={{
        width: 28,
        height: 28,
        borderRadius: 7,
        background: BRAND_GRADIENT,
        color: "white",
        flexShrink: 0,
      }}
    >
      {children}
    </Flex>
  );
}

function HelpPage() {
  const isMobile = useIsMobile();
  return (
    <AboutPage
      icon={<QuestionMarkCircledIcon width={20} height={20} />}
      title="Help"
      subtitle="Documentation and getting started"
    >
      {helpSections.map((section) => (
        <Card key={section.title} size={isMobile ? "2" : "3"}>
          <Flex align="center" gap="2" mb="2">
            <SectionIcon>{section.icon}</SectionIcon>
            <Heading size="4">{section.title}</Heading>
          </Flex>
          <Text as="p" size="2" color="gray" style={{ lineHeight: 1.65 }}>
            {section.content}
          </Text>
        </Card>
      ))}

      <Card size={isMobile ? "2" : "3"}>
        <Heading size="4" mb="2">
          Quick Reference
        </Heading>
        <Flex direction="column" gap="2">
          <Text size="2" color="gray">
            Press <Kbd>Cmd/Ctrl + /</Kbd> for the full list of keyboard shortcuts.
          </Text>
          <Text size="2" color="gray">
            Press <Kbd>Cmd/Ctrl + T</Kbd> to open the panel launcher or start a new chat.
          </Text>
        </Flex>
      </Card>
    </AboutPage>
  );
}

export default function AboutPanelRoot() {
  return (
    <AboutThemeRoot>
      <HelpPage />
    </AboutThemeRoot>
  );
}
