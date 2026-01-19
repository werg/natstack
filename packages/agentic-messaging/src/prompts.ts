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
- \`[Open Agent Manager](ns:///panels/agent-manager)\`
- \`[Open Agent Manager as child](ns:///panels/agent-manager?action=child)\`
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

// ============================================================================
// Restricted Mode System Prompt
// ============================================================================

/**
 * System prompt guidance for restricted environments where bash is unavailable.
 * This informs the LLM about available tools and their constraints.
 */
export const RESTRICTED_MODE_ENVIRONMENT_GUIDE = `## Environment Constraints

You are running in a restricted environment without shell access. You MUST use only the tools listed below.

### Always Available Tools

These tools are always available in restricted mode:

| Tool | Purpose | Use Instead Of |
|------|---------|----------------|
| \`Read\` | Read file contents | \`cat\`, \`head\`, \`tail\`, \`less\` |
| \`Write\` | Create/overwrite files | \`echo >\`, \`cat <<EOF\` |
| \`Edit\` | String replacement editing | \`sed\`, \`awk\`, manual editing |
| \`Glob\` | Find files by pattern | \`find\`, \`ls\` |
| \`Grep\` | Search file contents | \`grep\`, \`rg\`, \`ag\` |
| \`Tree\` | Show directory structure | \`tree\`, \`find\` |
| \`ListDirectory\` | List directory contents | \`ls\`, \`dir\` |
| \`GitStatus\` | Repository status | \`git status\` |
| \`GitDiff\` | Show file changes | \`git diff\` |
| \`GitLog\` | Commit history | \`git log\` |
| \`WebSearch\` | Search the web | browser search |
| \`WebFetch\` | Fetch web page content | \`curl\`, \`wget\` |

### Conditionally Available Tools

These tools MAY be available depending on your environment. Check if they work before relying on them:

| Tool | Purpose | Use Instead Of |
|------|---------|----------------|
| \`Remove\` | Delete files/directories | \`rm\`, \`rmdir\` |
| \`GitAdd\` | Stage files | \`git add\` |
| \`GitCommit\` | Create commits | \`git commit\` |
| \`GitCheckout\` | Switch branches/restore | \`git checkout\`, \`git switch\` |

If a conditionally available tool is unavailable, explain to the user what manual steps they can take instead.

### DISABLED Tools - Do NOT attempt to use these

The following tools/commands are NOT available in this environment. Do not try to call them:

**Shell/Bash commands (NO Bash tool available):**
- \`npm\`, \`yarn\`, \`pnpm\`, \`bun\` - package managers
- \`node\`, \`python\`, \`ruby\` - interpreters
- \`make\`, \`cargo\`, \`go build\` - build tools
- \`pytest\`, \`jest\`, \`vitest\` - test runners
- \`eslint\`, \`prettier\`, \`tsc\` - linters/formatters
- \`docker\`, \`kubectl\` - container tools
- \`ssh\`, \`scp\` - remote access
- Any other shell command

### Workflow Adaptations

1. **For git operations:** Use \`GitStatus\`, \`GitDiff\`, \`GitLog\` (always available) and \`GitAdd\`, \`GitCommit\`, \`GitCheckout\` (if available)
2. **For file search:** Use \`Glob\` and \`Grep\` tools, not \`find\` or \`rg\`
3. **For file editing:** Use \`Edit\` for replacements, not sed/awk
4. **For web lookups:** Use \`WebSearch\` and \`WebFetch\` for documentation, APIs, etc.
5. **For build/test commands:** Inform the user they must run these manually
   - Example: "Please run \`npm test\` to verify the changes"
6. **For installations:** Inform the user to install dependencies manually
   - Example: "Please run \`npm install lodash\` to add this dependency"`;

/**
 * Create a system prompt for restricted mode (no bash access).
 * Combines the rich text guide with restricted environment guidance.
 *
 * @param persona - Optional persona description
 * @returns Complete system prompt for restricted mode
 */
export function createRestrictedModeSystemPrompt(
  persona: string = DEFAULT_CHAT_ASSISTANT_PERSONA
): string {
  return `${persona}\n\n${COMPONENT_ENHANCED_RICH_TEXT_GUIDE}\n\n${RESTRICTED_MODE_ENVIRONMENT_GUIDE}`;
}
