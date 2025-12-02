import {
  Box,
  Flex,
  Text,
  Card,
  Badge,
  Button,
  Code,
  Heading,
  Em,
  Strong,
  Blockquote,
} from "@radix-ui/themes";
import { CodeBlock } from "./CodeBlock";

/**
 * Component documentation for the system prompt.
 * Each entry describes a component available in MDX scope.
 */
export interface ComponentDoc {
  name: string;
  description: string;
  props?: string;
  example?: string;
}

/**
 * Documentation for all available MDX components.
 * This is used to generate the system prompt section about available components.
 */
export const componentDocs: ComponentDoc[] = [
  // Layout components
  {
    name: "Box",
    description: "Basic layout container with padding, margin, and style props.",
    props: "p, px, py, m, mx, my, style",
    example: '<Box p="3" style={{ background: "var(--gray-3)" }}>Content</Box>',
  },
  {
    name: "Flex",
    description: "Flexbox container for arranging children in rows or columns.",
    props: "direction, align, justify, gap, wrap",
    example: '<Flex direction="column" gap="2" align="center">...</Flex>',
  },
  {
    name: "Card",
    description: "Contained surface for grouping related content with a subtle background.",
    props: "size, variant",
    example: "<Card><Text>Card content</Text></Card>",
  },

  // Typography components
  {
    name: "Text",
    description: "Typography component for body text. Supports size, weight, and color.",
    props: 'size ("1"-"9"), weight, color, as',
    example: '<Text size="3" color="gray">Styled text</Text>',
  },
  {
    name: "Heading",
    description: "Typography component for headings. Renders semantic h1-h6 tags.",
    props: 'size ("1"-"9"), as ("h1"-"h6")',
    example: '<Heading size="5" as="h2">Section Title</Heading>',
  },
  {
    name: "Code",
    description: "Inline code styling for technical terms or short code snippets.",
    props: "size, color, variant",
    example: "<Code>const x = 1</Code>",
  },
  {
    name: "Em",
    description: "Italic/emphasized text.",
    example: "<Em>emphasized text</Em>",
  },
  {
    name: "Strong",
    description: "Bold/strong text.",
    example: "<Strong>important text</Strong>",
  },
  {
    name: "Blockquote",
    description: "Styled quotation block for citations or callouts.",
    example: "<Blockquote>A notable quote</Blockquote>",
  },

  // Interactive components
  {
    name: "Button",
    description: "Clickable button with various styles. Use for actions.",
    props: 'size, variant ("solid", "soft", "outline", "ghost"), color',
    example: '<Button variant="soft" color="blue">Click me</Button>',
  },
  {
    name: "Badge",
    description: "Small label for status indicators, tags, or counts.",
    props: 'size, variant, color, radius',
    example: '<Badge color="green">Active</Badge>',
  },

  // Code display
  {
    name: "CodeBlock",
    description: "Syntax-highlighted code block with language support.",
    props: "code (string), language (string)",
    example: '<CodeBlock code="const x = 1;" language="typescript" />',
  },
];

/**
 * Generate a formatted string describing all available MDX components.
 * Used in the system prompt.
 */
export function generateComponentDocs(): string {
  const sections: string[] = [];

  sections.push("## Available MDX Components\n");
  sections.push("Your responses are rendered as MDX. You can use these components directly without imports:\n");

  for (const doc of componentDocs) {
    let entry = `### ${doc.name}\n${doc.description}`;
    if (doc.props) {
      entry += `\n**Props:** ${doc.props}`;
    }
    if (doc.example) {
      entry += `\n**Example:**\n\`\`\`jsx\n${doc.example}\n\`\`\``;
    }
    sections.push(entry);
  }

  sections.push("\n## MDX Tips\n");
  sections.push("- Standard markdown works: headings, lists, code blocks, links, emphasis");
  sections.push("- Embed JSX components inline with markdown");
  sections.push("- Components must be self-closing or have matching tags");
  sections.push("- Use curly braces for JavaScript expressions: {1 + 1}");

  return sections.join("\n\n");
}

/**
 * Default MDX components available to agent messages.
 *
 * These components are passed to the MDX evaluate() function,
 * making them available for use in MDX content without imports.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const mdxComponents: Record<string, React.ComponentType<any>> = {
  // Radix UI primitives - available directly in MDX
  Box,
  Flex,
  Text,
  Card,
  Badge,
  Button,
  Code,
  Heading,
  Em,
  Strong,
  Blockquote,

  // Custom components
  CodeBlock,

  // Override default HTML elements with Radix-styled versions
  // Note: We destructure and discard `color` to avoid type conflicts with Radix's strict color literals
  h1: ({ color: _, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <Heading size="6" mb="2" {...props} />
  ),
  h2: ({ color: _, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <Heading size="5" mb="2" {...props} />
  ),
  h3: ({ color: _, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <Heading size="4" mb="1" {...props} />
  ),
  h4: ({ color: _, ...props }: React.HTMLAttributes<HTMLHeadingElement>) => (
    <Heading size="3" mb="1" {...props} />
  ),
  p: ({ color: _, ...props }: React.HTMLAttributes<HTMLParagraphElement>) => (
    <Text as="p" size="2" mb="2" style={{ lineHeight: 1.6 }} {...props} />
  ),
  strong: (props: React.HTMLAttributes<HTMLElement>) => <Strong {...props} />,
  em: (props: React.HTMLAttributes<HTMLElement>) => <Em {...props} />,
  blockquote: ({ color: _, ...props }: React.HTMLAttributes<HTMLQuoteElement>) => (
    <Blockquote {...props} />
  ),
  // Code: handles both inline `code` and fenced ```code``` blocks
  code: ({
    children,
    className,
    color: _,
    ...props
  }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) => {
    // Fenced code blocks have a language-* class
    if (className?.startsWith("language-")) {
      const language = className.replace("language-", "") || "text";
      return <CodeBlock code={String(children || "").trim()} language={language} />;
    }
    // Inline code: `code`
    return <Code size="2" {...props}>{children}</Code>;
  },
  // pre: passthrough since code handler renders CodeBlock directly
  pre: ({ children }: React.HTMLAttributes<HTMLPreElement> & { children?: React.ReactNode }) => (
    <>{children}</>
  ),
  a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a
      style={{ color: "var(--accent-11)", textDecoration: "underline" }}
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    />
  ),
  ul: (props: React.HTMLAttributes<HTMLUListElement>) => (
    <ul
      style={{ paddingLeft: "1.5em", marginBottom: "0.5em" }}
      {...props}
    />
  ),
  ol: (props: React.OlHTMLAttributes<HTMLOListElement>) => (
    <ol
      style={{ paddingLeft: "1.5em", marginBottom: "0.5em" }}
      {...props}
    />
  ),
  li: (props: React.LiHTMLAttributes<HTMLLIElement>) => (
    <li style={{ marginBottom: "0.25em" }} {...props} />
  ),
  hr: () => (
    <Box
      my="3"
      style={{ borderTop: "1px solid var(--gray-6)", height: 0 }}
    />
  ),
};
