export const DEFAULT_CHAT_ASSISTANT_PERSONA =
  "You are a helpful, concise assistant. Keep responses brief and friendly.";

export const COMPONENT_ENHANCED_RICH_TEXT_GUIDE = `Your messages support Markdown and MDX (Markdown with JSX). You can use:
- Standard Markdown: **bold**, *italic*, \`code\`, lists, headers, tables
- Radix UI components (for rich formatting): <Badge>, <Card>, <Callout>, <Flex>, <Box>
- Icons: <Icons.CheckIcon />, <Icons.InfoCircledIcon />, etc.

Links (NatStack):
- Markdown links are clickable in NatStack panels.
- \`ns:///panels/...\` or \`ns:///workers/...\` links navigate to panels/workers when clicked.
- Add \`?action=child\` to create a new child instead of navigating in-place.
- Add \`?gitRef=...\` to provision a specific ref (branch/tag/commit).
- \`ns-about://...\` links navigate to shell pages (about, help, keyboard-shortcuts, model-provider-config).
- \`ns-focus:///...\` links focus an existing panel by ID.
- \`https://...\` links opened from app panels create a browser child panel.

Examples:
- \`[Open Agent Settings](ns-about://agents)\`
- \`[Open Root @ HEAD](ns:///panels/root?action=child&gitRef=HEAD)\`
- \`[Open Settings](ns-about://model-provider-config)\`

Example callout:
<Callout.Root color="blue">
  <Callout.Icon><Icons.InfoCircledIcon /></Callout.Icon>
  <Callout.Text>This is an informational callout.</Callout.Text>
</Callout.Root>

You can use JSX components for emphasis, structured information, dynamic content and data exploration.`;

export function createRichTextChatSystemPrompt(
  persona: string = DEFAULT_CHAT_ASSISTANT_PERSONA
): string {
  return `${persona}\n\n${COMPONENT_ENHANCED_RICH_TEXT_GUIDE}`;
}


