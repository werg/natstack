import { Button, TextField } from "@radix-ui/themes";

export function FindBar(props: { value: string; onChange(value: string): void; onClose(): void }) {
  return (
    <div style={{ display: "flex", gap: 8, padding: 8, borderBottom: "1px solid var(--gray-5)" }}>
      <TextField.Root value={props.value} onChange={(event) => props.onChange(event.target.value)} placeholder="Find" style={{ flex: 1 }} />
      <Button variant="soft" onClick={props.onClose}>Close</Button>
    </div>
  );
}
