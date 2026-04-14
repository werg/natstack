import { Box, Callout, Flex, IconButton, Text } from "@radix-ui/themes";
import { Cross1Icon, ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { useChatContext } from "../context/ChatContext";

/**
 * Renders a dismissible banner at the top of the chat whenever the
 * `ConnectionManager` has surfaced an error (subscribe failure or event-stream
 * rejection). Kept simple — one line per error — so the user immediately sees
 * that the chat is broken instead of staring at a silent empty panel.
 *
 * Cleared automatically on successful (re)connect; also dismissible by the
 * user. The `status` string is shown alongside so "Connecting..." vs
 * "error" is disambiguated.
 */
export function ChatConnectionErrorBanner() {
  const { connectionError, status, dismissConnectionError } = useChatContext();
  if (!connectionError) return null;

  return (
    <Box px="1" flexShrink="0">
      <Callout.Root color="red" size="1" variant="surface">
        <Callout.Icon>
          <ExclamationTriangleIcon />
        </Callout.Icon>
        <Flex align="center" justify="between" gap="2" width="100%">
          <Flex direction="column" gap="1" style={{ minWidth: 0, flex: 1 }}>
            <Text size="1" weight="medium">
              Connection error
            </Text>
            <Text size="1" style={{
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}>
              {connectionError.message} · status: {status}
            </Text>
          </Flex>
          {dismissConnectionError && (
            <IconButton
              size="1"
              variant="ghost"
              color="red"
              onClick={dismissConnectionError}
              aria-label="Dismiss connection error"
            >
              <Cross1Icon />
            </IconButton>
          )}
        </Flex>
      </Callout.Root>
    </Box>
  );
}
