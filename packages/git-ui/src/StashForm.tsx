import { useCallback, useState } from "react";
import { Box, Button, Flex, Text, TextField, Callout } from "@radix-ui/themes";
import { InfoCircledIcon } from "@radix-ui/react-icons";

export interface StashFormProps {
  onStash: (options: { message?: string }) => Promise<void>;
  disabled?: boolean;
  loading?: boolean;
}

export function StashForm({ onStash, disabled, loading }: StashFormProps) {
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = useCallback(async () => {
    if (disabled || loading || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await onStash({ message: message.trim() || undefined });
      setMessage("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }, [disabled, loading, submitting, onStash, message]);

  return (
    <Box p="3">
      <Flex direction="column" gap="2">
        <Flex align="center" justify="between" gap="2">
          <TextField.Root
            placeholder="Stash message (optional)"
            value={message}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => setMessage(e.target.value)}
            disabled={disabled || loading || submitting}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !disabled && !loading && !submitting) {
                void handleSubmit();
              }
            }}
          />
          <Button
            size="2"
            variant="soft"
            onClick={() => void handleSubmit()}
            disabled={disabled || loading || submitting}
            loading={submitting}
          >
            Stash
          </Button>
        </Flex>

        {/* Note about untracked files (#18) */}
        <Callout.Root size="1" color="gray">
          <Callout.Icon>
            <InfoCircledIcon />
          </Callout.Icon>
          <Callout.Text size="1">
            Stash only saves tracked files. Untracked files will remain in your working directory.
          </Callout.Text>
        </Callout.Root>

        {error && (
          <Text size="1" color="red">
            {error}
          </Text>
        )}
      </Flex>
    </Box>
  );
}
