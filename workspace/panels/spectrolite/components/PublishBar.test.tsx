// @vitest-environment jsdom

import { Theme } from "@radix-ui/themes";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AppProvider } from "../app/context";
import type { SpectroliteApp } from "../app/createApp";
import type { PublishSnapshot } from "../app/publishController";
import { vaultPathMapping } from "../app/vaultContext";
import { PublishBar } from "./PublishBar";

function renderPublishBar(snapshot: PublishSnapshot, dirtyPaths: string[] = []) {
  const openFile = vi.fn();
  const abort = vi.fn(async () => undefined);
  const publish = vi.fn(async (_message?: string) => ({ status: "published" as const }));
  const rebase = vi.fn(async () => "merged" as const);
  const publishStore = {
    subscribe: vi.fn(() => () => undefined),
    getSnapshot: vi.fn(() => snapshot),
    publish,
    rebase,
    abort,
  };
  // PublishBar reads `dirtyPaths` via `useAppState` (the app store), so the mock
  // must supply a minimal store snapshot alongside the publish controller.
  const appState = { dirtyPaths };
  const store = {
    subscribe: vi.fn(() => () => undefined),
    getState: vi.fn(() => appState),
  };
  const app = {
    store,
    publish: publishStore,
    vault: {
      mapping: () => vaultPathMapping("projects/notes"),
    },
    openFile,
  } as unknown as SpectroliteApp;

  render(
    <Theme>
      <AppProvider value={app}>
        <PublishBar />
      </AppProvider>
    </Theme>
  );

  return { abort, openFile, publish, rebase };
}

describe("PublishBar", () => {
  it("surfaces pending conflict kinds and opens mapped vault files", () => {
    const snapshot: PublishSnapshot = {
      ahead: 1,
      uncommitted: 0,
      files: [],
      deleted: false,
      diverged: false,
      publishing: false,
      pending: {
        theirsHead: "main",
        conflicts: [
          { path: "projects/notes/Chapter.mdx", kind: "content" },
          { path: "projects/notes/cover.png", kind: "binary" },
          { path: "projects/other/Foreign.mdx", kind: "delete-vs-change" },
        ],
      },
      buildReport: null,
      behind: false,
      lastError: null,
    };

    const { openFile, publish } = renderPublishBar(snapshot);

    expect(screen.getByTestId("spectrolite-publish-conflict-kind-0").textContent).toBe("content");
    expect(screen.getByTestId("spectrolite-publish-conflict-kind-1").textContent).toBe("binary");
    expect(screen.getByTestId("spectrolite-publish-conflict-kind-2").textContent).toBe("delete-vs-change");
    expect(screen.getByText("Chapter.mdx")).toBeTruthy();
    expect(screen.getByText("cover.png")).toBeTruthy();
    expect(screen.getByText("Not openable")).toBeTruthy();

    fireEvent.click(screen.getByTestId("spectrolite-publish-resolve"));
    expect(openFile).toHaveBeenCalledWith("Chapter.mdx");

    fireEvent.click(screen.getByTestId("spectrolite-publish-open-1"));
    expect(openFile).toHaveBeenCalledWith("cover.png");

    fireEvent.click(screen.getByTestId("spectrolite-publish-complete"));
    expect(publish).toHaveBeenCalledWith("Resolve merge");
  });

  it("keeps abort available for pending conflicts", () => {
    const snapshot: PublishSnapshot = {
      ahead: 0,
      uncommitted: 0,
      files: [],
      deleted: false,
      diverged: false,
      publishing: false,
      pending: {
        theirsHead: "main",
        conflicts: [{ path: "projects/notes/Chapter.mdx", kind: "mode" }],
      },
      buildReport: null,
      behind: false,
      lastError: null,
    };

    const { abort } = renderPublishBar(snapshot);

    fireEvent.click(screen.getByTestId("spectrolite-publish-abort"));
    expect(abort).toHaveBeenCalledTimes(1);
  });

  it("surfaces a build-failed push report inline", () => {
    const snapshot: PublishSnapshot = {
      ahead: 1,
      uncommitted: 0,
      files: [],
      deleted: false,
      diverged: false,
      publishing: false,
      pending: null,
      buildReport: [
        {
          repoPath: "projects/notes",
          kind: "content",
          role: "pushed",
          status: "failed",
          builds: [
            {
              target: "runtime",
              diagnostics: [
                {
                  source: "tsc",
                  severity: "error",
                  file: "projects/notes/Chapter.mdx",
                  line: 4,
                  column: 2,
                  message: "unexpected token",
                },
              ],
            },
          ],
        },
      ],
      behind: false,
      lastError: null,
    };

    renderPublishBar(snapshot);
    const banner = screen.getByTestId("spectrolite-publish-build-failed");
    expect(banner.textContent).toContain("projects/notes/Chapter.mdx:4:2");
  });

  it("enables publish for durable uncommitted edits even with no local dirty path", () => {
    const snapshot: PublishSnapshot = {
      ahead: 0,
      uncommitted: 2,
      files: [],
      deleted: false,
      diverged: false,
      publishing: false,
      pending: null,
      buildReport: null,
      behind: false,
      lastError: null,
    };

    renderPublishBar(snapshot);

    expect(screen.getByTestId("spectrolite-publish-status").textContent).toBe("Uncommitted changes");
    expect((screen.getByTestId("spectrolite-publish-button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("blocks publish when the repo was deleted", () => {
    const snapshot: PublishSnapshot = {
      ahead: 1,
      uncommitted: 1,
      files: [],
      deleted: true,
      diverged: false,
      publishing: false,
      pending: null,
      buildReport: null,
      behind: false,
      lastError: null,
    };

    renderPublishBar(snapshot);

    expect(screen.getByTestId("spectrolite-publish-status").textContent).toBe("Repo deleted");
    expect((screen.getByTestId("spectrolite-publish-button") as HTMLButtonElement).disabled).toBe(true);
  });

  it("allows publish and disables sync when a diverged repo has uncommitted edits", () => {
    const snapshot: PublishSnapshot = {
      ahead: 0,
      uncommitted: 2,
      files: [],
      deleted: false,
      diverged: true,
      publishing: false,
      pending: null,
      buildReport: null,
      behind: true,
      lastError: null,
    };

    const { publish, rebase } = renderPublishBar(snapshot);

    expect(screen.getByTestId("spectrolite-publish-status").textContent).toBe(
      "Needs sync, uncommitted changes"
    );
    expect((screen.getByTestId("spectrolite-publish-button") as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByTestId("spectrolite-sync-button") as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(screen.getByTestId("spectrolite-publish-button"));
    fireEvent.click(screen.getByTestId("spectrolite-sync-button"));

    expect(publish).toHaveBeenCalledTimes(1);
    expect(rebase).not.toHaveBeenCalled();
  });
});
