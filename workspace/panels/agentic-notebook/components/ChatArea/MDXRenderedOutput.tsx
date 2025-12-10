import { Box } from "@radix-ui/themes";
import { MDXContent } from "./MDXContent";
import { mdxComponents } from "./mdxComponents";

interface MDXRenderedOutputProps {
  /** The MDX content string to render */
  content: string;
}

/**
 * MDXRenderedOutput - Renders compiled MDX content.
 *
 * This is an output-only component. The parent ToolResultDisplay
 * handles the chrome (header, input display, etc).
 */
export function MDXRenderedOutput({ content }: MDXRenderedOutputProps) {
  return (
    <Box>
      <MDXContent content={content} components={mdxComponents} />
    </Box>
  );
}
