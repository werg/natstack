import { Box, Button, Flex, Text } from "@radix-ui/themes";
import { Cross2Icon } from "@radix-ui/react-icons";
import { useEffect, useRef, useState } from "react";
import { attachWithScrollback } from "./useShellExtension.js";
import { parseNotifications } from "./notificationParser.js";
import type { SessionInfo, ShellApi } from "./types.js";

type TerminalLike = {
  open(el: HTMLElement): void;
  write(data: string | Uint8Array): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onResize(cb: (size: { cols: number; rows: number }) => void): { dispose(): void };
  loadAddon(addon: unknown): void;
  dispose(): void;
};
const dynamicImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;

export function PaneView(props: {
  shell: ShellApi;
  session: SessionInfo;
  fontSize: number;
  focused: boolean;
  onFocus(): void;
  onClose(): void;
  onNotification(message: string): void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [fallback, setFallback] = useState("");

  useEffect(() => {
    let cancelled = false;
    let terminal: TerminalLike | null = null;
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    let disposables: Array<{ dispose(): void }> = [];

    async function start() {
      const host = hostRef.current;
      if (!host) return;
      try {
        const xterm = await dynamicImport("xterm");
        const fit = await dynamicImport("xterm-addon-fit").catch(() => null);
        const TerminalCtor = (xterm as unknown as { Terminal: new (opts: Record<string, unknown>) => TerminalLike }).Terminal;
        terminal = new TerminalCtor({
          cursorBlink: true,
          fontFamily: "JetBrains Mono, Menlo, Consolas, monospace",
          fontSize: props.fontSize,
          theme: { background: "#111113", foreground: "#eeeeee" },
        });
        const fitAddon = fit ? new ((fit as unknown as { FitAddon: new () => { fit(): void } }).FitAddon)() : null;
        if (fitAddon) terminal.loadAddon(fitAddon);
        terminal.open(host);
        fitAddon?.fit();
        disposables = [
          terminal.onData((data) => {
            void props.shell.write(props.session.sessionId, data);
          }),
          terminal.onResize(({ cols, rows }) => {
            void props.shell.resize(props.session.sessionId, cols, rows);
          }),
        ];
        const response = await attachWithScrollback(props.shell, props.session.sessionId);
        reader = response.body?.getReader() ?? null;
        const decoder = new TextDecoder();
        while (!cancelled && reader) {
          const next = await reader.read();
          if (next.done) break;
          terminal.write(next.value);
          for (const notif of parseNotifications(decoder.decode(next.value))) {
            props.onNotification(notif.message);
          }
        }
      } catch {
        const response = await attachWithScrollback(props.shell, props.session.sessionId);
        reader = response.body?.getReader() ?? null;
        const decoder = new TextDecoder();
        while (!cancelled && reader) {
          const next = await reader.read();
          if (next.done) break;
          const text = decoder.decode(next.value);
          setFallback((prev) => `${prev}${text}`.slice(-16_000));
          for (const notif of parseNotifications(text)) props.onNotification(notif.message);
        }
      }
    }
    void start();
    return () => {
      cancelled = true;
      void reader?.cancel();
      for (const disposable of disposables) disposable.dispose();
      terminal?.dispose();
    };
  }, [props.shell, props.session.sessionId, props.fontSize]);

  return (
    <Flex direction="column" style={{
      minHeight: 0,
      border: props.focused ? "1px solid var(--accent-8)" : "1px solid var(--gray-5)",
      borderRadius: 6,
      overflow: "hidden",
      background: "var(--gray-1)",
    }} onMouseDown={props.onFocus}>
      <Flex align="center" justify="between" px="2" py="1" style={{ borderBottom: "1px solid var(--gray-5)" }}>
        <Text size="1">{props.session.label}</Text>
        <Button size="1" variant="ghost" onClick={props.onClose}><Cross2Icon /></Button>
      </Flex>
      <div ref={hostRef} style={{ flex: 1, minHeight: 220, background: "#111113" }}>
        {fallback ? <pre style={{ margin: 0, padding: 8, color: "#eee", whiteSpace: "pre-wrap" }}>{fallback}</pre> : null}
      </div>
      <Box px="2" py="1">
        <Text size="1" color="gray">{props.session.command.cwd} · {props.session.cols}x{props.session.rows}</Text>
      </Box>
    </Flex>
  );
}
