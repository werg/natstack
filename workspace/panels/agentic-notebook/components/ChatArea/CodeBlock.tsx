import { IconButton, Tooltip } from "@radix-ui/themes";
import { CopyIcon, CheckIcon } from "@radix-ui/react-icons";
import { useState, useCallback } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

interface CodeBlockProps {
  code: string;
  language?: string;
  padded?: boolean;
}

/**
 * Shared, theme-friendly code block with syntax highlighting and copy.
 */
export function CodeBlock({ code, language = "typescript", padded = true }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1600);
      },
      (err) => {
        console.error("Failed to copy:", err);
      }
    );
  }, [code]);

  return (
    <div style={{ position: "relative" }}>
      <div style={{ position: "absolute", top: 6, right: 6, zIndex: 1 }}>
        <Tooltip content={copied ? "Copied!" : "Copy"}>
          <IconButton
            size="1"
            variant="ghost"
            color={copied ? "green" : "gray"}
            onClick={handleCopy}
            style={{ opacity: copied ? 1 : 0.6 }}
          >
            {copied ? <CheckIcon /> : <CopyIcon />}
          </IconButton>
        </Tooltip>
      </div>
      <SyntaxHighlighter
        language={language}
        style={oneDark}
        showLineNumbers={false}
        wrapLongLines
        customStyle={{
          margin: 0,
          borderRadius: "var(--radius-2)",
          background: "var(--gray-3)",
          border: "1px solid var(--gray-6)",
          fontSize: "12px",
          padding: padded ? "12px" : "8px",
        }}
        codeTagProps={{
          style: { fontFamily: "var(--code-font-family, 'JetBrains Mono', monospace')" },
        }}
      >
        {code || " "}
      </SyntaxHighlighter>
    </div>
  );
}
