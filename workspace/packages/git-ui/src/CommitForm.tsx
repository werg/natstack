import { useState, useCallback, KeyboardEvent } from "react";
import { Flex, TextArea, Button, Text } from "@radix-ui/themes";

export interface CommitFormProps {
  onCommit: (message: string) => Promise<void>;
  onCancel?: () => void;
  disabled?: boolean;
  loading?: boolean;
}

/**
 * Commit message form with textarea and submit button
 */
export function CommitForm({ onCommit, onCancel, disabled, loading }: CommitFormProps) {
  const [message, setMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Compute trimmed message once to avoid redundant trim calls
  const trimmedMessage = message.trim();

  const handleSubmit = useCallback(async () => {
    if (!trimmedMessage || disabled || loading || isSubmitting) return;

    setIsSubmitting(true);
    setSubmitError(null);
    try {
      await onCommit(trimmedMessage);
      setMessage(""); // Clear on success
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsSubmitting(false);
    }
  }, [trimmedMessage, disabled, loading, isSubmitting, onCommit]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLTextAreaElement>) => {
      // Ctrl+Enter or Cmd+Enter to submit
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
        e.preventDefault();
        void handleSubmit();
      }
      // ESC to cancel
      if (e.key === "Escape" && onCancel) {
        e.preventDefault();
        onCancel();
      }
    },
    [handleSubmit, onCancel]
  );

  const isDisabled = disabled || loading || isSubmitting || !trimmedMessage;

  return (
    <Flex direction="column" gap="2" p="3">
      <TextArea
        placeholder="Commit message..."
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={handleKeyDown}
        disabled={loading || isSubmitting}
        rows={3}
        autoFocus
      />
      {submitError && (
        <Text size="1" color="red">
          {submitError}
        </Text>
      )}
      {!trimmedMessage && !submitError && (
        <Text size="1" color="amber">
          Enter a commit message to continue
        </Text>
      )}
      <Flex align="center" justify="between">
        <Text size="1" color="gray">
          Ctrl+Enter to commit · Esc to cancel
        </Text>
        <Flex gap="2">
          {onCancel && (
            <Button
              size="2"
              variant="soft"
              color="gray"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
          )}
          <Button
            size="2"
            onClick={handleSubmit}
            disabled={isDisabled}
            loading={isSubmitting}
          >
            Commit Changes
          </Button>
        </Flex>
      </Flex>
    </Flex>
  );
}
