import { Grid } from "@radix-ui/themes";
import { PaneView } from "./PaneView.js";
import type { SessionInfo, ShellApi, SplitNode } from "./types.js";

export function SplitTree(props: {
  node: SplitNode;
  sessions: Record<string, SessionInfo>;
  focusedSessionId?: string;
  shell: ShellApi;
  fontSize: number;
  onFocus(sessionId: string): void;
  onClose(sessionId: string): void;
  onNotification(sessionId: string, message: string): void;
}) {
  if (props.node.kind === "leaf") {
    const session = props.sessions[props.node.sessionId];
    if (!session) return null;
    return (
      <PaneView
        shell={props.shell}
        session={session}
        fontSize={props.fontSize}
        focused={props.focusedSessionId === session.sessionId}
        onFocus={() => props.onFocus(session.sessionId)}
        onClose={() => props.onClose(session.sessionId)}
        onNotification={(message) => props.onNotification(session.sessionId, message)}
      />
    );
  }
  return (
    <Grid
      gap="2"
      style={{
        minHeight: 0,
        height: "100%",
        gridTemplateColumns: props.node.direction === "row" ? `${props.node.ratio}fr ${1 - props.node.ratio}fr` : undefined,
        gridTemplateRows: props.node.direction === "column" ? `${props.node.ratio}fr ${1 - props.node.ratio}fr` : undefined,
      }}
    >
      <SplitTree {...props} node={props.node.a} />
      <SplitTree {...props} node={props.node.b} />
    </Grid>
  );
}
