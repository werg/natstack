import { Badge, DropdownMenu, Flex, IconButton, Text } from "@radix-ui/themes";
import { DotsHorizontalIcon, EnterFullScreenIcon, ViewHorizontalIcon, ViewVerticalIcon } from "@radix-ui/react-icons";
import { headerBackground, headerBorderColor, paneAttentionShadow, severityDotColor } from "./paneChrome.js";
import { sessionExitText } from "./sessionStatus.js";
import type { NotificationSeverity, SessionInfo } from "./types.js";
import { normalizeLocalhostUrl } from "./urlUtils.js";
import {
  formatCommandDuration,
  liveSessionCommandState,
  liveSessionCwd,
} from "./vscodeShellIntegrationMeta.js";

export function PaneHeader(props: {
  session: SessionInfo;
  focused: boolean;
  severity: NotificationSeverity;
  onSplitRight(): void;
  onSplitDown(): void;
  onOpenPort(port: number): void;
  onClose(): void;
  onClear(): void;
  onCopyAll(): void;
  onDuplicate(): void;
  onOpenPreview(): void;
  onRename(): void;
  onRestart(): void;
  onRestartCommand(): void;
  onFind(): void;
  onZoom(): void;
}) {
  const ports = props.session.detectedPorts.slice(0, 3);
  const exitText = sessionExitText(props.session);
  const preview = previewTarget(props.session);
  const cwd = liveSessionCwd(props.session) ?? props.session.command.cwd;
  const commandState = liveSessionCommandState(props.session);
  const commandDuration = commandState.state !== "running"
    ? formatCommandDuration(commandState.durationMs)
    : undefined;
  return (
    <Flex
      align="center"
      justify="between"
      px="2"
      py="1"
      style={{
        borderBottom: `1px solid ${headerBorderColor(props.severity, props.focused)}`,
        background: headerBackground(props.focused),
        boxShadow: paneAttentionShadow(props.severity) ?? (props.focused ? "inset 0 -1px 0 var(--accent-7)" : undefined),
      }}
    >
      <Flex align="center" gap="2" minWidth="0">
        <span style={{ width: "0.5rem", height: "0.5rem", borderRadius: "999px", background: severityDotColor(props.severity, props.session.alive) }} />
        <Text size="1" weight="medium" truncate>{props.session.label}</Text>
        {exitText ? <Badge size="1" color="red" variant="soft">{exitText}</Badge> : null}
        {!exitText && commandState.state === "running" ? (
          <Badge size="1" color="blue" variant="soft">running</Badge>
        ) : null}
        {!exitText && commandState.state === "failed" ? (
          <Badge size="1" color="red" variant="soft">
            exit {commandState.exitCode}{commandDuration ? ` · ${commandDuration}` : ""}
          </Badge>
        ) : null}
        {props.session.gitBranch ? <Text size="1" color="gray" truncate>{props.session.gitBranch}</Text> : null}
        <Text size="1" color="gray" truncate>{basename(cwd)}</Text>
        {ports.map((port) => (
          <button
            key={port}
            onClick={() => props.onOpenPort(port)}
            style={{ border: 0, padding: 0, background: "transparent" }}
          >
            <Badge size="1" variant="soft" color="blue">:{port}</Badge>
          </button>
        ))}
      </Flex>
      <Flex align="center" gap="1">
        <IconButton size="1" variant="ghost" aria-label="Split right" onClick={props.onSplitRight}><ViewVerticalIcon /></IconButton>
        <IconButton size="1" variant="ghost" aria-label="Split down" onClick={props.onSplitDown}><ViewHorizontalIcon /></IconButton>
        <IconButton size="1" variant="ghost" aria-label="Zoom pane" onClick={props.onZoom}><EnterFullScreenIcon /></IconButton>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger>
            <IconButton size="1" variant="ghost" aria-label="Pane menu"><DotsHorizontalIcon /></IconButton>
          </DropdownMenu.Trigger>
          <DropdownMenu.Content size="1">
            <DropdownMenu.Item onSelect={props.onClear}>Clear scrollback</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onCopyAll}>Copy all</DropdownMenu.Item>
            <DropdownMenu.Item disabled={!preview} onSelect={props.onOpenPreview}>Open preview</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onDuplicate}>Duplicate</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onRename}>Rename</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onFind}>Find</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onRestart}>Restart session</DropdownMenu.Item>
            <DropdownMenu.Item onSelect={props.onRestartCommand}>Restart command</DropdownMenu.Item>
            <DropdownMenu.Separator />
            <DropdownMenu.Item color="red" onSelect={props.onClose}>Close</DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Root>
      </Flex>
    </Flex>
  );
}

export function previewTarget(session: SessionInfo): { kind: "url"; url: string } | { kind: "port"; port: number } | undefined {
  const url = session.detectedUrls.find((item) => /^https?:\/\//i.test(item));
  if (url) return { kind: "url", url: normalizeLocalhostUrl(url) };
  const port = session.detectedPorts[0];
  return port ? { kind: "port", port } : undefined;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
