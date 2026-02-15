import { useAtomValue, useSetAtom } from "jotai";
import { Box, Flex, Text, Button, Card, Spinner } from "@radix-ui/themes";
import {
  stashesAtom,
  stashLoadingAtom,
  stashActionLoadingAtom,
  stashErrorAtom,
  hasChangesAtom,
  actionLoadingAtom,
  dropStashIndexAtom,
  createStashAtom,
  applyStashAtom,
  popStashAtom,
} from "./store";
import { StashForm } from "./StashForm";
import { LoadingState } from "./LoadingState";
import { formatRelativeTime, timestampToDate } from "./utils";

/**
 * Stash management section content
 */
export function StashSection() {
  const stashes = useAtomValue(stashesAtom);
  const stashLoading = useAtomValue(stashLoadingAtom);
  const stashActionLoading = useAtomValue(stashActionLoadingAtom);
  const stashError = useAtomValue(stashErrorAtom);
  const hasChanges = useAtomValue(hasChangesAtom);
  const actionLoading = useAtomValue(actionLoadingAtom);

  const createStash = useSetAtom(createStashAtom);
  const applyStash = useSetAtom(applyStashAtom);
  const popStash = useSetAtom(popStashAtom);
  const setDropStashIndex = useSetAtom(dropStashIndexAtom);

  const handleApplyStash = (index: number) => void applyStash(index);
  const handlePopStash = (index: number) => void popStash(index);

  return (
    <>
      {hasChanges ? (
        <StashForm
          onStash={createStash}
          loading={stashActionLoading || actionLoading}
        />
      ) : (
        <Box p="3">
          <Text size="2" color="gray">
            No changes to stash
          </Text>
        </Box>
      )}

      {stashError && (
        <Box p="3">
          <Text size="2" color="red">
            {stashError.message}
          </Text>
        </Box>
      )}

      {stashLoading ? (
        <LoadingState />
      ) : stashes.length === 0 ? (
        <Box p="3">
          <Text size="2" color="gray">
            No stashes
          </Text>
        </Box>
      ) : (
        <Flex direction="column" p="2" gap="2">
          {stashes.map((s) => (
            <Card key={s.ref} size="1">
              <Flex
                align="center"
                justify="between"
                gap="2"
                p="2"
                style={{ opacity: stashActionLoading ? 0.7 : 1 }}
              >
                <Flex direction="column" gap="1">
                  <Flex align="center" gap="2">
                    <Text size="2" weight="medium">
                      {s.ref}
                    </Text>
                    {stashActionLoading && <Spinner size="1" />}
                  </Flex>
                  <Text size="2" truncate>
                    {s.message || "(no message)"}
                  </Text>
                  {typeof s.timestamp === "number" && (() => {
                    const date = timestampToDate(s.timestamp);
                    return date ? (
                      <Text size="1" color="gray">
                        {formatRelativeTime(date)}
                      </Text>
                    ) : null;
                  })()}
                </Flex>
                <Flex gap="2" align="center">
                  <Button
                    size="1"
                    variant="soft"
                    onClick={() => handleApplyStash(s.index)}
                    disabled={stashActionLoading || actionLoading}
                  >
                    Apply
                  </Button>
                  <Button
                    size="1"
                    variant="soft"
                    onClick={() => handlePopStash(s.index)}
                    disabled={stashActionLoading || actionLoading}
                  >
                    Pop
                  </Button>
                  <Button
                    size="1"
                    variant="soft"
                    color="red"
                    onClick={() => setDropStashIndex(s.index)}
                    disabled={stashActionLoading || actionLoading}
                  >
                    Drop
                  </Button>
                </Flex>
              </Flex>
            </Card>
          ))}
        </Flex>
      )}
    </>
  );
}
