export const DEFAULT_CHAT_ASSISTANT_PERSONA =
  "You are a helpful, concise assistant. Keep responses brief and friendly.";

export const COMPONENT_ENHANCED_RICH_TEXT_GUIDE = `Your messages support Markdown and MDX (Markdown with JSX). You can use:
- Standard Markdown: **bold**, *italic*, \`code\`, lists, headers, tables
- Radix UI components (for rich formatting): <Badge>, <Card>, <Callout>, <Flex>, <Box>
- Icons: <Icons.CheckIcon />, <Icons.InfoCircledIcon />, etc.

Links (NatStack):
- Markdown links are clickable in NatStack panels.
- \`natstack-child:///panels/...\` or \`natstack-child:///workers/...\` links create child panels/workers when clicked.
- Optional \`#gitRef\` fragment provisions a specific ref (branch/tag/commit), e.g. \`natstack-child:///panels/root#HEAD\`.
- \`https://...\` links opened from app panels create a browser child panel.

Examples:
- \`[Open Agent Manager](natstack-child:///panels/agent-manager)\`
- \`[Open Root @ HEAD](natstack-child:///panels/root#HEAD)\`

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
