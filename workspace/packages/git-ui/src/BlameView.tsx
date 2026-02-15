import { useMemo } from "react";
import { Box, Text } from "@radix-ui/themes";
import type { BlameLine } from "@natstack/git";
import { MonacoErrorBoundary } from "./MonacoErrorBoundary";
import { MonacoEditor as Editor } from "./MonacoEditor";
import { MIN_EDITOR_HEIGHT } from "./constants";

interface BlameViewProps {
  content: string;
  blame: BlameLine[];
  theme?: "light" | "dark";
}

function formatBlameLabel(info?: BlameLine): string {
  if (!info) return "";
  const author = info.author.split(" ")[0] ?? info.author;
  return `${author} ${info.commit.slice(0, 7)}`;
}

export function BlameView({ content, blame, theme }: BlameViewProps) {
  const lineNumbers = useMemo(() => {
    return (lineNumber: number) => formatBlameLabel(blame[lineNumber - 1]);
  }, [blame]);

  if (blame.length === 0) {
    return (
      <Text size="2" color="gray">
        No blame information available
      </Text>
    );
  }

  return (
    <Box height="50vh" minHeight={`${MIN_EDITOR_HEIGHT}px`}>
      <MonacoErrorBoundary fallbackHeight="50vh">
        <Editor
          value={content}
          theme={theme === "dark" ? "vs-dark" : "light"}
          height="100%"
          readOnly
          options={{
            minimap: { enabled: false },
            lineNumbers,
            lineNumbersMinChars: 24,
            scrollBeyondLastLine: false,
          }}
        />
      </MonacoErrorBoundary>
    </Box>
  );
}
