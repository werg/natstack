import type { ComponentType } from "react";
import type { Components } from "react-markdown";
import {
  Badge,
  Blockquote,
  Box,
  Button,
  Callout,
  Card,
  Code,
  Flex,
  Heading,
  Link,
  Table,
  Text,
} from "@radix-ui/themes";
import * as Icons from "@radix-ui/react-icons";

export const markdownComponents: Components = {
  h1: ({ children }) => (
    <Heading size="6" mb="2">
      {children}
    </Heading>
  ),
  h2: ({ children }) => (
    <Heading size="5" mb="2">
      {children}
    </Heading>
  ),
  h3: ({ children }) => (
    <Heading size="4" mb="1">
      {children}
    </Heading>
  ),
  h4: ({ children }) => (
    <Heading size="3" mb="1">
      {children}
    </Heading>
  ),
  p: ({ children }) => (
    <Text as="p" size="2" mb="2">
      {children}
    </Text>
  ),
  a: ({ href, children }) => <Link href={href ?? ""}>{children}</Link>,
  code: ({ children, className, ...props }) => {
    const inline =
      typeof (props as { inline?: boolean }).inline === "boolean"
        ? Boolean((props as { inline?: boolean }).inline)
        : !(className?.includes("language-") ?? false);

    if (!inline) {
      return (
        <Box my="2">
          <Box as="pre" className="ns-codeblock" m="0">
            <Box as="code" className={className} style={{ display: "block" }}>
              {children}
            </Box>
          </Box>
        </Box>
      );
    }

    const text = String(children ?? "").replace(/\n$/, "");
    return <Code size="2">{text}</Code>;
  },
  pre: ({ children }) => <>{children}</>,
  blockquote: ({ children }) => <Blockquote>{children}</Blockquote>,
  ul: ({ children }) => (
    <Box as="ul" pl="4" mb="2">
      {children}
    </Box>
  ),
  ol: ({ children }) => (
    <Box as="ol" pl="4" mb="2">
      {children}
    </Box>
  ),
  li: ({ children }) => (
    <Text as="li" size="2">
      {children}
    </Text>
  ),
  strong: ({ children }) => <Text weight="bold">{children}</Text>,
  em: ({ children }) => <Text style={{ fontStyle: "italic" }}>{children}</Text>,
};

export const mdxComponents: Record<string, ComponentType | unknown> = {
  ...markdownComponents,
  Badge,
  Blockquote,
  Box,
  Button,
  Callout,
  Card,
  Code,
  Flex,
  Heading,
  Link,
  Table,
  Text,
  Icons,
};
