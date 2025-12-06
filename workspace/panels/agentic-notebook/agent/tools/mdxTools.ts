import { compileMDX, MDXCompileError } from "@natstack/build-mdx";
import type { AgentTool } from "../AgentSession";
import { generateComponentDocs } from "../../components/ChatArea/mdxComponents";

/**
 * Tool execution result format.
 */
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

/**
 * Create MDX rendering tools for the agent.
 */
export function createMDXTools(): AgentTool[] {
  const componentDocs = generateComponentDocs();

  return [
    {
      name: "render_mdx",
      description: `Render rich MDX content with React components directly in the chat.

Use this tool when you want to display formatted content with interactive UI components,
structured layouts, or styled elements beyond plain markdown.

MDX is a superset of Markdown that supports embedded JSX components. The content you provide
will be compiled and rendered in the chat interface. MDX can also import modules from OPFS.

${componentDocs}

## When to Use This Tool

- Displaying structured data with Cards and Badges
- Creating visual layouts with Flex and Box
- Showing status indicators or labels
- Highlighting important information
- Any time plain markdown isn't expressive enough

## Example

\`\`\`mdx
Here's the analysis result:

<Card>
  <Flex direction="column" gap="2">
    <Flex justify="between" align="center">
      <Text weight="bold">Build Status</Text>
      <Badge color="green">Passed</Badge>
    </Flex>
    <Text size="2" color="gray">All 12 tests completed successfully.</Text>
  </Flex>
</Card>

### Summary
- **Duration:** 2.3 seconds
- **Coverage:** 94%
\`\`\`

Note: The tool returns any compilation errors. If rendering fails, check your JSX syntax.`,
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description: "The MDX content to render. Supports markdown and JSX components.",
          },
        },
        required: ["content"],
      },
      execute: async (args): Promise<ToolResult> => {
        const content = args.content as string | undefined;

        if (!content || typeof content !== "string" || content.trim() === "") {
          return {
            content: [{ type: "text", text: "Error: No content provided. The 'content' parameter is required." }],
            isError: true,
          };
        }

        // Validate the MDX by compiling it - catch syntax errors before claiming success
        try {
          await compileMDX(content, {});
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const errorType = err instanceof MDXCompileError ? "MDX compilation error" : "Error";
          return {
            content: [{ type: "text", text: `${errorType}: ${message}` }],
            isError: true,
          };
        }

        // MDX compiled successfully - the UI will render it from the tool call args
        return {
          content: [{
            type: "text",
            text: "Rendered successfully.",
          }],
        };
      },
    },
  ];
}
