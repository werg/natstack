import { Box, Button, Flex, Text, Badge, Tooltip } from "@radix-ui/themes";
import { ArrowDownIcon, ArrowUpIcon } from "@radix-ui/react-icons";
import type { GitProgress, RemoteStatus } from "@natstack/git";
import { PushPullProgress } from "./PushPullProgress";

export interface RemoteOperationsBarProps {
  status: RemoteStatus | null;
  loading?: boolean;
  isPulling?: boolean;
  isPushing?: boolean;
  progress?: GitProgress | null;
  onPull: () => void;
  onPush: () => void;
}

export function RemoteOperationsBar({
  status,
  loading,
  isPulling,
  isPushing,
  progress,
  onPull,
  onPush,
}: RemoteOperationsBarProps) {
  if (!status) {
    return null;
  }

  const pullDisabled = loading || isPulling || status.behind === 0;
  const pushDisabled = loading || isPushing || status.ahead === 0;

  return (
    <Box>
      <Flex align="center" gap="2" wrap="wrap">
        <Text size="1" color="gray">
          {status.remote}/{status.remoteBranch}
        </Text>
        {status.diverged && (
          <Tooltip content="Local and remote have diverged. Pull to merge changes.">
            <Badge size="1" variant="soft" color="orange">
              Diverged
            </Badge>
          </Tooltip>
        )}
        <Tooltip content={status.behind > 0
          ? `Pull ${status.behind} commit${status.behind > 1 ? "s" : ""} from ${status.remote}`
          : "Up to date with remote"
        }>
          <Button size="1" variant="soft" onClick={onPull} disabled={pullDisabled}>
            <ArrowDownIcon />
            Pull
            {status.behind > 0 && <Badge size="1" variant="solid" color="blue">{status.behind}</Badge>}
          </Button>
        </Tooltip>
        <Tooltip content={status.ahead > 0
          ? `Push ${status.ahead} commit${status.ahead > 1 ? "s" : ""} to ${status.remote}`
          : "Nothing to push"
        }>
          <Button size="1" variant="soft" onClick={onPush} disabled={pushDisabled}>
            <ArrowUpIcon />
            Push
            {status.ahead > 0 && <Badge size="1" variant="solid" color="green">{status.ahead}</Badge>}
          </Button>
        </Tooltip>
      </Flex>
      {progress && <PushPullProgress progress={progress} />}
    </Box>
  );
}
