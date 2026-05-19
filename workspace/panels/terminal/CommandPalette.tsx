import { Button, Dialog, Flex, Text, TextField } from "@radix-ui/themes";
import { useState } from "react";

export function CommandPalette(props: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onRun(command: string): Promise<string>;
}) {
  const [command, setCommand] = useState("");
  const [result, setResult] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content maxWidth="720px">
        <Dialog.Title>Run Command</Dialog.Title>
        <Flex direction="column" gap="3">
          <TextField.Root
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            placeholder="git status"
            onKeyDown={(event) => {
              if (event.key === "Enter" && command.trim()) {
                setBusy(true);
                void props.onRun(command.trim()).then(setResult).finally(() => setBusy(false));
              }
            }}
          />
          <Button disabled={busy || !command.trim()} onClick={() => {
            setBusy(true);
            void props.onRun(command.trim()).then(setResult).finally(() => setBusy(false));
          }}>Run</Button>
          {result ? <pre style={{ maxHeight: 280, overflow: "auto", margin: 0, fontSize: 12 }}>{result}</pre> : <Text size="2" color="gray">Approval appears in the host approval bar.</Text>}
        </Flex>
      </Dialog.Content>
    </Dialog.Root>
  );
}
