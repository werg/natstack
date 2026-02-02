import type { ComponentType, ReactNode } from "react";
import type { Components } from "react-markdown";
import {
  Badge,
  Blockquote,
  Box,
  Button,
  Callout as RadixCallout,
  Card,
  Code,
  Flex,
  Heading,
  Link,
  Table,
  Text,
} from "@radix-ui/themes";
// Curated icon subset for MDX components (~saves 400KB vs wildcard import)
// These are the icons commonly used by agents in MDX content
import {
  CheckIcon,
  CheckCircledIcon,
  InfoCircledIcon,
  ExclamationTriangleIcon,
  CrossCircledIcon,
  QuestionMarkCircledIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  MinusIcon,
  GearIcon,
  Pencil1Icon,
  TrashIcon,
  CopyIcon,
  DownloadIcon,
  UploadIcon,
  FileIcon,
  FileTextIcon,
  CodeIcon,
  Link2Icon,
  ExternalLinkIcon,
  MagnifyingGlassIcon,
  LightningBoltIcon,
  RocketIcon,
  StarIcon,
  HeartIcon,
  BellIcon,
  LockClosedIcon,
  LockOpen1Icon,
  PersonIcon,
  HomeIcon,
  CalendarIcon,
  ClockIcon,
  ReloadIcon,
  UpdateIcon,
  PlayIcon,
  PauseIcon,
  StopIcon,
} from "@radix-ui/react-icons";

// Re-export as Icons namespace for MDX components: <Icons.CheckIcon />
const Icons = {
  CheckIcon,
  CheckCircledIcon,
  InfoCircledIcon,
  ExclamationTriangleIcon,
  CrossCircledIcon,
  QuestionMarkCircledIcon,
  ArrowRightIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  ArrowDownIcon,
  ChevronRightIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  PlusIcon,
  MinusIcon,
  GearIcon,
  Pencil1Icon,
  TrashIcon,
  CopyIcon,
  DownloadIcon,
  UploadIcon,
  FileIcon,
  FileTextIcon,
  CodeIcon,
  Link2Icon,
  ExternalLinkIcon,
  MagnifyingGlassIcon,
  LightningBoltIcon,
  RocketIcon,
  StarIcon,
  HeartIcon,
  BellIcon,
  LockClosedIcon,
  LockOpen1Icon,
  PersonIcon,
  HomeIcon,
  CalendarIcon,
  ClockIcon,
  ReloadIcon,
  UpdateIcon,
  PlayIcon,
  PauseIcon,
  StopIcon,
};

// Custom Callout wrapper that uses div instead of p for Text to avoid HTML nesting issues
// (MDX content inside Callout.Text can contain <p>, <ul>, <ol> which can't nest in <p>)
const CalloutText = ({ children, ...props }: { children?: ReactNode }) => (
  <Text as="div" size="2" {...props}>
    {children}
  </Text>
);

const Callout = Object.assign(RadixCallout.Root, {
  Root: RadixCallout.Root,
  Icon: RadixCallout.Icon,
  Text: CalloutText,
});

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
          <pre className="ns-codeblock" style={{ margin: 0 }}>
            <code className={className} style={{ display: "block" }}>
              {children}
            </code>
          </pre>
        </Box>
      );
    }

    const text = String(children ?? "").replace(/\n$/, "");
    return <Code size="2">{text}</Code>;
  },
  pre: ({ children }) => <>{children}</>,
  blockquote: ({ children }) => <Blockquote>{children}</Blockquote>,
  ul: ({ children }) => (
    <ul style={{ paddingLeft: "var(--space-4)", marginBottom: "var(--space-2)" }}>
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol style={{ paddingLeft: "var(--space-4)", marginBottom: "var(--space-2)" }}>
      {children}
    </ol>
  ),
  li: ({ children }) => (
    <li style={{ fontSize: "var(--font-size-2)" }}>
      {children}
    </li>
  ),
  strong: ({ children }) => <Text weight="bold">{children}</Text>,
  em: ({ children }) => <Text style={{ fontStyle: "italic" }}>{children}</Text>,
};

export const mdxComponents = {
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
