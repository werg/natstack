import { useState, useCallback } from "react";
import { IconButton, Tooltip } from "@radix-ui/themes";
import { CopyIcon, CheckIcon } from "@radix-ui/react-icons";

interface CopyButtonProps {
  text: string;
  size?: "1" | "2";
}

/**
 * Copy button with success feedback.
 */
export function CopyButton({ text, size = "1" }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [text]);

  return (
    <Tooltip content={copied ? "Copied!" : "Copy"}>
      <IconButton
        size={size}
        variant="ghost"
        color={copied ? "green" : "gray"}
        onClick={handleCopy}
        style={{ opacity: copied ? 1 : 0.6 }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </IconButton>
    </Tooltip>
  );
}
