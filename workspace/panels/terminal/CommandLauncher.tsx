import { Badge, ContextMenu, Dialog, Flex, Kbd, Text, TextField } from "@radix-ui/themes";
import { LightningBoltIcon } from "@radix-ui/react-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { useIsMobile, useViewportHeight } from "@workspace/react/responsive";
import {
  commandTargetForEnter,
  hasCommandTargetModifier,
  type CommandRunTarget,
} from "./commandLauncherModel.js";
import { loadCommandSuggestions, type CommandSuggestion } from "./commandSources.js";
import {
  buildCommandRows,
  offsetForSuggestion,
  visibleCommandRows,
} from "./commandVirtualization.js";
import type { SavedLayout } from "./types.js";

export function CommandLauncher(props: {
  open: boolean;
  cwd?: string;
  history: string[];
  layouts: SavedLayout[];
  onOpenChange(open: boolean): void;
  onRun(command: string, target: CommandRunTarget): Promise<void>;
  onBuiltin(action: string): void;
  onLoadLayout(layoutId: string): Promise<void>;
  onRenameLayout(layoutId: string): void;
  onDeleteLayout(layoutId: string): void;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
  const [scrollTop, setScrollTop] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const isMobile = useIsMobile();
  const windowHeight = useViewportHeight();
  const viewportHeight = isMobile ? Math.min(352, Math.floor(windowHeight * 0.58)) : 352;
  const commandRows = useMemo(() => buildCommandRows(suggestions), [suggestions]);
  const visibleRows = useMemo(
    () => visibleCommandRows(commandRows.rows, scrollTop, viewportHeight),
    [commandRows.rows, scrollTop]
  );

  useEffect(() => {
    if (!props.open) return;
    void loadCommandSuggestions({
      query,
      cwd: props.cwd,
      history: props.history,
      layouts: props.layouts,
    }).then((items) => {
      setSuggestions(items);
      setSelected(0);
      setScrollTop(0);
    });
  }, [props.open, query, props.cwd, props.history, props.layouts]);

  useEffect(() => {
    const list = listRef.current;
    const offset = offsetForSuggestion(commandRows.rows, selected);
    if (!list || !offset) return;
    const visibleBottom = list.scrollTop + list.clientHeight;
    if (offset.top < list.scrollTop) list.scrollTo({ top: offset.top });
    else if (offset.top + offset.height > visibleBottom)
      list.scrollTo({ top: offset.top + offset.height - list.clientHeight });
  }, [commandRows.rows, selected]);

  async function accept(suggestion: CommandSuggestion, target: CommandRunTarget) {
    if (suggestion.kind === "builtin") props.onBuiltin(suggestion.action);
    else if (suggestion.kind === "layout") await props.onLoadLayout(suggestion.layoutId);
    else await props.onRun(suggestion.command, target);
    props.onOpenChange(false);
    setQuery("");
  }

  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content
        maxWidth={isMobile ? "calc(100vw - 24px)" : "640px"}
        style={{ marginTop: isMobile ? "4dvh" : "12vh", padding: 0, overflow: "hidden" }}
      >
        <TextField.Root
          size="3"
          value={query}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Run command or action"
          style={{ borderRadius: 0, border: 0 }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setSelected((value) => Math.min(suggestions.length - 1, value + 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setSelected((value) => Math.max(0, value - 1));
            } else if (event.key === "Enter" && suggestions[selected]) {
              event.preventDefault();
              const suggestion = suggestions[selected];
              if (!suggestion) return;
              const target = hasCommandTargetModifier(event)
                ? commandTargetForEnter(event)
                : suggestionDefaultTarget(suggestion);
              void accept(suggestion, target);
            }
          }}
        >
          <TextField.Slot>
            <LightningBoltIcon />
          </TextField.Slot>
        </TextField.Root>
        <div
          ref={listRef}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          style={{
            height: viewportHeight,
            overflow: "auto",
            borderTop: "1px solid var(--gray-5)",
            borderBottom: "1px solid var(--gray-5)",
          }}
        >
          {suggestions.length === 0 ? (
            <Flex align="center" justify="center" minHeight="6rem">
              <Text size="2" color="gray">
                No commands found
              </Text>
            </Flex>
          ) : (
            <div style={{ height: commandRows.totalHeight, position: "relative" }}>
              {visibleRows.map((row) =>
                row.type === "section" ? (
                  <SectionHeader key={row.key} kind={row.kind} top={row.top} height={row.height} />
                ) : (
                  <SuggestionRow
                    key={row.key}
                    suggestion={row.suggestion}
                    selected={row.index === selected}
                    top={row.top}
                    height={row.height}
                    onMouseEnter={() => setSelected(row.index)}
                    onAccept={() =>
                      void accept(row.suggestion, suggestionDefaultTarget(row.suggestion))
                    }
                    onAcceptTarget={(target) => void accept(row.suggestion, target)}
                    onRenameLayout={() =>
                      row.suggestion.kind === "layout" &&
                      props.onRenameLayout(row.suggestion.layoutId)
                    }
                    onDeleteLayout={() =>
                      row.suggestion.kind === "layout" &&
                      props.onDeleteLayout(row.suggestion.layoutId)
                    }
                  />
                )
              )}
            </div>
          )}
        </div>
        <Flex align="center" gap="3" px="3" py="2" wrap="wrap">
          <Text size="1" color="gray">
            <Kbd>Enter</Kbd> split right
          </Text>
          <Text size="1" color="gray">
            <Kbd>Shift Enter</Kbd> new tab
          </Text>
          <Text size="1" color="gray">
            <Kbd>Ctrl/Cmd Enter</Kbd> split right
          </Text>
          <Text size="1" color="gray">
            <Kbd>Ctrl/Cmd Shift Enter</Kbd> split down
          </Text>
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}

function suggestionDefaultTarget(suggestion: CommandSuggestion): CommandRunTarget {
  return "defaultTarget" in suggestion && suggestion.defaultTarget
    ? suggestion.defaultTarget
    : "splitRight";
}

function SuggestionRow(props: {
  suggestion: CommandSuggestion;
  selected: boolean;
  top: number;
  height: number;
  onMouseEnter(): void;
  onAccept(): void;
  onAcceptTarget(target: CommandRunTarget): void;
  onRenameLayout(): void;
  onDeleteLayout(): void;
}) {
  const row = (
    <div
      onMouseEnter={props.onMouseEnter}
      style={{
        display: "flex",
        position: "absolute",
        top: props.top,
        height: props.height,
        alignItems: "center",
        gap: "var(--space-3)",
        width: "100%",
        padding: "var(--space-2) var(--space-3)",
        border: 0,
        textAlign: "left",
        background: props.selected ? "var(--accent-3)" : "var(--gray-1)",
        color: "var(--gray-12)",
      }}
    >
      <button
        onClick={props.onAccept}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--space-3)",
          minWidth: 0,
          flex: 1,
          border: 0,
          padding: 0,
          background: "transparent",
          color: "inherit",
          textAlign: "left",
        }}
      >
        <Text size="1" color="gray" style={{ width: "4.5rem", textTransform: "uppercase" }}>
          {props.suggestion.kind}
        </Text>
        <Flex direction="column" minWidth="0" style={{ flex: 1 }}>
          <Text size="2" weight="medium" truncate>
            {props.suggestion.label}
          </Text>
          {props.suggestion.subtitle ? (
            <Text size="1" color="gray" truncate>
              {props.suggestion.subtitle}
            </Text>
          ) : null}
        </Flex>
      </button>
      {canChooseRunTarget(props.suggestion) && props.selected ? (
        <Flex gap="1" flexShrink="0">
          <TargetChip label="Here" color="gray" onClick={() => props.onAcceptTarget("here")} />
          <TargetChip
            label="Right"
            color="blue"
            onClick={() => props.onAcceptTarget("splitRight")}
          />
          <TargetChip
            label="Down"
            color="amber"
            onClick={() => props.onAcceptTarget("splitDown")}
          />
          <TargetChip label="Tab" color="green" onClick={() => props.onAcceptTarget("tab")} />
        </Flex>
      ) : (
        <Badge
          size="1"
          variant={props.selected ? "solid" : "soft"}
          color={targetBadgeColor(props.suggestion)}
          style={{ opacity: props.selected ? 1 : 0.72, flex: "0 0 auto" }}
        >
          {targetLabel(props.suggestion)}
        </Badge>
      )}
    </div>
  );

  if (props.suggestion.kind !== "layout") return row;
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger>{row}</ContextMenu.Trigger>
      <ContextMenu.Content>
        <ContextMenu.Item onSelect={props.onRenameLayout}>Rename layout...</ContextMenu.Item>
        <ContextMenu.Item color="red" onSelect={props.onDeleteLayout}>
          Delete layout
        </ContextMenu.Item>
      </ContextMenu.Content>
    </ContextMenu.Root>
  );
}

function TargetChip(props: {
  label: string;
  color: "gray" | "blue" | "green" | "amber";
  onClick(): void;
}) {
  return (
    <button
      onClick={(event) => {
        event.stopPropagation();
        props.onClick();
      }}
      style={{ border: 0, padding: 0, background: "transparent" }}
    >
      <Badge size="1" variant="soft" color={props.color}>
        {props.label}
      </Badge>
    </button>
  );
}

function canChooseRunTarget(suggestion: CommandSuggestion): boolean {
  return suggestion.kind === "recent" || suggestion.kind === "project" || suggestion.kind === "raw";
}

function targetLabel(suggestion: CommandSuggestion): string {
  if (suggestion.kind === "builtin") return "Action";
  if (suggestion.kind === "layout") return "Open";
  const target = suggestionDefaultTarget(suggestion);
  if (target === "here") return "Here";
  if (target === "tab") return "New tab";
  if (target === "splitDown") return "Split down";
  return "Split right";
}

function targetBadgeColor(suggestion: CommandSuggestion): "gray" | "blue" | "green" | "amber" {
  if (suggestion.kind === "builtin") return "gray";
  if (suggestion.kind === "layout") return "green";
  const target = suggestionDefaultTarget(suggestion);
  if (target === "here") return "gray";
  if (target === "splitDown") return "amber";
  if (target === "tab") return "green";
  return "blue";
}

function SectionHeader(props: { kind: CommandSuggestion["kind"]; top: number; height: number }) {
  return (
    <Flex
      align="center"
      px="3"
      style={{
        position: "absolute",
        top: props.top,
        height: props.height,
        width: "100%",
        background: "var(--gray-1)",
      }}
    >
      <Text size="1" color="gray" weight="medium" style={{ textTransform: "uppercase" }}>
        {sectionLabel(props.kind)}
      </Text>
    </Flex>
  );
}

function sectionLabel(kind: CommandSuggestion["kind"]): string {
  if (kind === "recent") return "Recent";
  if (kind === "project") return "Project commands";
  if (kind === "layout") return "Layouts";
  if (kind === "builtin") return "Builtins";
  return "Run as command";
}
