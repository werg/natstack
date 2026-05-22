import { Box, Button, Flex, Text } from "@radix-ui/themes";
import { useState } from "react";

interface OnboardingActionBarProps {
  chat: {
    publish: (type: string, payload: Record<string, unknown>) => Promise<unknown>;
  };
}

const actionGroups = [
  {
    title: "Connect services",
    description: "Let the agent work with accounts, APIs, and models.",
    actions: [
      { label: "Google Workspace", message: "Set up Google Workspace provider integration" },
      { label: "GitHub", message: "Set up GitHub provider integration" },
      { label: "Slack", message: "Set up Slack provider integration" },
      { label: "Model/API key", message: "Set up a model or API key provider" },
      { label: "Agent defaults", message: "I want to change the agent's default model or tune its behavior" },
      { label: "Custom API", message: "Set up a custom OAuth or API provider" },
    ],
  },
  {
    title: "Bring in local context",
    description: "Import browser state when you want cookies, bookmarks, or passwords available locally.",
    actions: [
      { label: "Browser import", message: "Import browser data" },
    ],
  },
  {
    title: "Build or explore",
    description: "Create your first panel, inspect runtime APIs, or organize workspaces.",
    actions: [
      { label: "Build a panel", message: "Help me build a panel" },
      { label: "Explore runtime", message: "Show me what NatStack runtime APIs can do" },
      { label: "Workspaces", message: "Help me organize NatStack workspaces" },
    ],
  },
];

export default function OnboardingActionBar({ chat }: OnboardingActionBarProps) {
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);

  async function send(label: string, message: string) {
    setPendingLabel(label);
    try {
      await chat.publish("message", {
        content: message,
        metadata: { source: "onboarding-action-bar", action: label },
      });
    } finally {
      setPendingLabel(null);
    }
  }

  return (
    <Flex direction="column" gap="2" p="2">
      <Flex align="baseline" gap="2" wrap="wrap">
        <Text size="2" weight="bold">
          Start here
        </Text>
        <Text size="1" color="gray">
          Pick a path and the onboarding agent will tailor the next step.
        </Text>
      </Flex>
      <Flex gap="3" wrap="wrap" align="start">
        {actionGroups.map((group) => (
          <Box key={group.title} style={{ minWidth: 190, flex: "1 1 220px" }}>
            <Flex direction="column" gap="1">
              <Text size="1" weight="bold" color="gray">
                {group.title}
              </Text>
              <Text size="1" color="gray" style={{ lineHeight: 1.25 }}>
                {group.description}
              </Text>
              <Flex gap="1" wrap="wrap" pt="1">
                {group.actions.map((action) => (
                  <Button
                    key={action.label}
                    size="1"
                    variant="soft"
                    type="button"
                    disabled={pendingLabel !== null}
                    onClick={() => send(action.label, action.message)}
                    style={{ flex: "0 0 auto", whiteSpace: "nowrap" }}
                  >
                    {pendingLabel === action.label ? "Sending..." : action.label}
                  </Button>
                ))}
              </Flex>
            </Flex>
          </Box>
        ))}
      </Flex>
    </Flex>
  );
}
