/**
 * PublishBar — the VCS-native publish indicator + one-click Publish.
 *
 * The vault lives on a durable per-vault context head; `main` / `/projects`
 * move only on an explicit Publish. This bar shows "● N unpublished changes"
 * (from {@link PublishController}, a ctx-head-vs-`main` diff) and a Publish
 * button (pull-main-then-publish). A conflicted pull parks on the panel's own
 * head and is surfaced inline with Resolve / Complete / Abort.
 *
 * Subtle by design: when there is nothing to publish and no pending merge, the
 * bar collapses to a quiet "Published" line.
 */

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Badge, Button, Flex, Popover, Text, TextField } from "@radix-ui/themes";
import {
  UploadIcon,
  ExclamationTriangleIcon,
  Cross1Icon,
  FileTextIcon,
  UpdateIcon,
} from "@radix-ui/react-icons";
import { useApp, useAppState } from "../app/context";
import type { PublishSnapshot } from "../app/publishController";
import { getPublishPresentation } from "./publishPresentation";

export function PublishBar({ mobile = false, trailing }: { mobile?: boolean; trailing?: ReactNode }) {
  const app = useApp();
  const snapshot = useSyncExternalStore(
    (cb) => app.publish.subscribe(cb),
    () => app.publish.getSnapshot(),
    () => app.publish.getSnapshot(),
  );
  // Working-copy dirtiness (uncommitted local edits). With deliberate commits
  // there is no commit-per-keystroke stream, so the "unpublished" indicator must
  // count uncommitted edits too, not just committed-but-unpushed (`ahead`).
  const dirtyCount = useAppState((s) => s.dirtyPaths.length);

  if (snapshot.pending) {
    return <PendingMergeBar snapshot={snapshot} mobile={mobile} />;
  }
  const presentation = getPublishPresentation(snapshot, dirtyCount);

  return (
    <Flex
      align="center"
      justify="between"
      gap="2"
      px="3"
      py="2"
      className="spectrolite-publish-bar"
      data-testid="spectrolite-publish-bar"
      style={{ borderTop: "1px solid var(--gray-4)", minHeight: mobile ? 52 : undefined }}
    >
      <Flex align="center" gap="2" style={{ minWidth: 0 }}>
        <span
          aria-hidden
          style={{
            color: presentation.hasChanges ? "var(--iris-9)" : "var(--gray-7)",
            fontSize: 10,
            lineHeight: 1,
          }}
        >
          ●
        </span>
        <Text size="1" color="gray" truncate data-testid="spectrolite-publish-status">
          {presentation.statusLabel}
        </Text>
        {snapshot.lastError ? (
          <Text size="1" color="red" truncate title={snapshot.lastError}>
            · {snapshot.lastError}
          </Text>
        ) : snapshot.buildReport ? (
          <Text
            size="1"
            color="red"
            truncate
            data-testid="spectrolite-publish-build-failed"
            title={buildReportSummary(snapshot.buildReport)}
          >
            · {buildReportSummary(snapshot.buildReport)}
          </Text>
        ) : null}
      </Flex>
      {/* On mobile the Send action lives here (one action bar, not a separate
          strip), so the editor keeps maximum vertical room. */}
      <Flex align="center" gap="2" style={{ flexShrink: 0 }}>
        {trailing}
        {snapshot.behind ? (
          <Button
            size={mobile ? "2" : "1"}
            variant="soft"
            color="amber"
            disabled={snapshot.publishing || presentation.syncBlockedByUncommitted}
            onClick={() => void app.publish.rebase()}
            data-testid="spectrolite-sync-button"
            title={
              presentation.syncBlockedByUncommitted
                ? "Publish or discard local edits before syncing"
                : "main advanced — pull the latest into your view"
            }
            style={mobile ? { minHeight: 40 } : undefined}
          >
            <UpdateIcon /> Sync
          </Button>
        ) : null}
        <Button
          size={mobile ? "2" : "1"}
          variant={presentation.hasChanges ? "solid" : "soft"}
          color={presentation.hasChanges ? "iris" : "gray"}
          disabled={!presentation.hasChanges || snapshot.publishing || presentation.publishBlocked}
          onClick={() => void app.publish.publish()}
          data-testid="spectrolite-publish-button"
          style={mobile ? { minHeight: 40 } : undefined}
        >
          <UploadIcon /> {snapshot.publishing ? "Publishing…" : "Publish"}
        </Button>
      </Flex>
    </Flex>
  );
}

/** A one-line summary of a build-failed push: the diagnostic count + first message. */
function buildReportSummary(reports: PublishSnapshot["buildReport"]): string {
  const diags = (reports ?? []).flatMap((r) => r.builds.flatMap((b) => b.diagnostics));
  if (diags.length === 0) return "Publish blocked by a build error";
  const first = diags[0]!;
  const where = `${first.file}:${first.line}:${first.column}`;
  const more = diags.length > 1 ? ` (+${diags.length - 1} more)` : "";
  return `Build failed — ${where} ${first.message}${more}`;
}

function PendingMergeBar({ snapshot, mobile = false }: { snapshot: PublishSnapshot; mobile?: boolean }) {
  const app = useApp();
  const conflicts = snapshot.pending?.conflicts ?? [];
  const mapping = app.vault.mapping();
  const conflictItems = conflicts.map((conflict) => {
    const vaultRelPath = mapping.toVaultRelPath(conflict.path);
    return {
      ...conflict,
      displayPath: vaultRelPath ?? conflict.path,
      vaultRelPath,
    };
  });
  const firstOpenable = conflictItems.find((conflict) => conflict.vaultRelPath !== null);
  const openConflict = (path: string) => {
    app.openFile(path);
  };

  return (
    <Flex
      direction="column"
      gap="1"
      px="3"
      py="2"
      className="spectrolite-publish-bar"
      data-testid="spectrolite-publish-pending"
      style={{ borderTop: "1px solid var(--amber-6)", background: "var(--amber-2)" }}
    >
      <Flex align="center" justify="between" gap="2">
        <Flex align="center" gap="2" style={{ minWidth: 0 }}>
          <ExclamationTriangleIcon color="var(--amber-11)" />
          <Text size="1" color="amber" truncate>
            Pull from main needs resolving ({conflicts.length} file{conflicts.length === 1 ? "" : "s"})
          </Text>
        </Flex>
        <Flex align="center" gap="1" style={{ flexShrink: 0 }}>
          {firstOpenable?.vaultRelPath ? (
            <Button
              size={mobile ? "2" : "1"}
              variant="solid"
              color="amber"
              onClick={() => openConflict(firstOpenable.vaultRelPath!)}
              data-testid="spectrolite-publish-resolve"
              style={mobile ? { minHeight: 40 } : undefined}
            >
              <FileTextIcon /> Resolve
            </Button>
          ) : null}
          <Button
            size={mobile ? "2" : "1"}
            variant="solid"
            color="iris"
            disabled={snapshot.publishing}
            onClick={() => void app.publish.publish("Resolve merge")}
            data-testid="spectrolite-publish-complete"
            style={mobile ? { minHeight: 40 } : undefined}
          >
            <UploadIcon /> {snapshot.publishing ? "Completing…" : "Complete"}
          </Button>
          <Button
            size={mobile ? "2" : "1"}
            variant="soft"
            color="gray"
            disabled={snapshot.publishing}
            onClick={() => void app.publish.abort()}
            data-testid="spectrolite-publish-abort"
            style={mobile ? { minHeight: 40 } : undefined}
          >
            <Cross1Icon /> Abort
          </Button>
        </Flex>
      </Flex>
      {snapshot.lastError ? (
        <Text size="1" color="red" truncate title={snapshot.lastError}>
          {snapshot.lastError}
        </Text>
      ) : null}
      {conflictItems.length > 0 ? (
        <Flex
          direction="column"
          gap="1"
          className="spectrolite-publish-conflicts"
          data-testid="spectrolite-publish-conflicts"
        >
          {conflictItems.map((conflict, index) => (
            <Flex
              key={`${conflict.path}:${conflict.kind}:${index}`}
              align="center"
              gap="2"
              className="spectrolite-publish-conflict-row"
              data-testid={`spectrolite-publish-conflict-${index}`}
            >
              <Badge size="1" color="amber" variant="soft" data-testid={`spectrolite-publish-conflict-kind-${index}`}>
                {conflict.kind}
              </Badge>
              <Flex direction="column" gap="1" style={{ minWidth: 0, flex: 1 }}>
                <Text size="1" weight="medium" truncate title={conflict.displayPath}>
                  {conflict.displayPath}
                </Text>
                {conflict.vaultRelPath === null ? (
                  <Text size="1" color="gray" truncate title={conflict.path}>
                    Outside this vault: {conflict.path}
                  </Text>
                ) : conflict.displayPath !== conflict.path ? (
                  <Text size="1" color="gray" truncate title={conflict.path}>
                    {conflict.path}
                  </Text>
                ) : null}
              </Flex>
              {conflict.vaultRelPath ? (
                <Button
                  size="1"
                  variant="soft"
                  color="amber"
                  onClick={() => openConflict(conflict.vaultRelPath!)}
                  data-testid={`spectrolite-publish-open-${index}`}
                >
                  <FileTextIcon /> Open
                </Button>
              ) : (
                <Text size="1" color="gray" style={{ flexShrink: 0 }}>
                  Not openable
                </Text>
              )}
            </Flex>
          ))}
        </Flex>
      ) : null}
    </Flex>
  );
}
