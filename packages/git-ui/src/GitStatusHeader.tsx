import { useState } from "react";
import { Flex, Text, Button, IconButton, Tooltip, Kbd } from "@radix-ui/themes";
import { Cross2Icon, ReloadIcon, GearIcon, KeyboardIcon, ChevronUpIcon } from "@radix-ui/react-icons";
import { BranchSelector } from "./BranchSelector";
import { RemoteOperationsBar } from "./RemoteOperationsBar";
import { AuthErrorDialog } from "./AuthErrorDialog";
import { SettingsDialog } from "./SettingsDialog";
import { useGitRemote } from "./hooks/useGitRemote";
import type { DiffViewOptions } from "./DiffBlock";

export interface GitStatusHeaderProps {
  branch: string | null;
  onCommit?: () => void;
  onClose?: () => void;
  onRefresh?: () => void;
  onMinimize?: () => void;
  hasStaged: boolean;
  loading?: boolean;
  diffViewOptions?: DiffViewOptions;
  onDiffViewOptionsChange?: (options: DiffViewOptions) => void;
}

/**
 * Header bar with branch name, commit button, refresh button, and close action
 */
export function GitStatusHeader({
  branch,
  onCommit,
  onClose,
  onRefresh,
  onMinimize,
  hasStaged,
  loading,
  diffViewOptions,
  onDiffViewOptionsChange,
}: GitStatusHeaderProps) {
  const remote = useGitRemote();
  const [showSettings, setShowSettings] = useState(false);

  return (
    <Flex align="center" justify="between" p="2" gap="2" wrap="wrap">
      <Flex align="center" gap="2" wrap="wrap">
        <Text size="2" weight="medium">
          Git
        </Text>
        <BranchSelector currentBranch={branch} />
      </Flex>

      <Flex align="center" gap="2" wrap="wrap">
        <RemoteOperationsBar
          status={remote.status}
          loading={remote.loading}
          isPulling={remote.isPulling}
          isPushing={remote.isPushing}
          progress={remote.progress}
          onPull={() => void remote.pull()}
          onPush={() => void remote.push()}
        />
        <Tooltip content={<Flex align="center" gap="2">Keyboard shortcuts <Kbd>?</Kbd></Flex>}>
          <IconButton
            size="1"
            variant="ghost"
            onClick={() => setShowSettings(true)}
            aria-label="Keyboard shortcuts"
          >
            <KeyboardIcon />
          </IconButton>
        </Tooltip>
        {diffViewOptions && onDiffViewOptionsChange && (
          <Tooltip content="Settings">
            <IconButton
              size="1"
              variant="ghost"
              onClick={() => setShowSettings(true)}
              aria-label="Settings"
            >
              <GearIcon />
            </IconButton>
          </Tooltip>
        )}
        {onRefresh && (
          <Tooltip content={<Flex align="center" gap="2">Refresh <Kbd>r</Kbd></Flex>}>
            <IconButton
              size="1"
              variant="ghost"
              onClick={onRefresh}
              aria-label="Refresh"
              disabled={loading}
            >
              <ReloadIcon />
            </IconButton>
          </Tooltip>
        )}
        {onCommit && (
          <Tooltip content={<Flex align="center" gap="2">Commit <Kbd>c</Kbd></Flex>}>
            <Button
              size="1"
              variant="solid"
              onClick={onCommit}
              disabled={!hasStaged || loading}
            >
              Commit
            </Button>
          </Tooltip>
        )}
        {onMinimize && (
          <Tooltip content="Minimize header">
            <IconButton
              size="1"
              variant="ghost"
              onClick={onMinimize}
              aria-label="Minimize header"
            >
              <ChevronUpIcon />
            </IconButton>
          </Tooltip>
        )}
        {onClose && (
          <Tooltip content={<Flex align="center" gap="2">Close <Kbd>Esc</Kbd></Flex>}>
            <IconButton
              size="1"
              variant="ghost"
              onClick={onClose}
              aria-label="Close"
            >
              <Cross2Icon />
            </IconButton>
          </Tooltip>
        )}
      </Flex>

      <AuthErrorDialog
        open={remote.authError !== null}
        onOpenChange={(open) => {
          if (!open) remote.clearAuthError();
        }}
        message={remote.authError?.message}
      />

      {diffViewOptions && onDiffViewOptionsChange && (
        <SettingsDialog
          open={showSettings}
          onOpenChange={setShowSettings}
          diffViewOptions={diffViewOptions}
          onDiffViewOptionsChange={onDiffViewOptionsChange}
        />
      )}
    </Flex>
  );
}
