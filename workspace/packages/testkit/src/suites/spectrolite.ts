/**
 * Spectrolite suite — in-system port of the core tests from
 * tests/e2e/flows/spectrolite.spec.ts.
 *
 * The outside spec builds vault fixtures on the host filesystem before
 * launching Electron; here the fixture vault is created in context fs via the
 * runtime fs and workspace VCS client, and the panel is opened with the same stateArgs
 * ({ repoRoot, openPath }). DOM interaction goes through CDP (driver DO
 * route for workspace panels).
 *
 * Not ported (still outside-only): first-run vault picker + agent add/remove
 * + vault switching (deep dialog flows tied to channel agents), commit/flush
 * keyboard editing flows (Electron input events), mobile-viewport variant
 * (covered generically by the panel-viewport suite).
 */
import { vcs } from "@workspace/runtime";
import { suite } from "../run.js";
import { expect } from "../expect.js";
import { evalInPanel, panelText, waitFor, waitForText, withPanel } from "../panels.js";
import { profilePanel } from "../profile.js";

const VAULT = "/projects/testkit-vault";
const LARGE_VAULT = "/projects/testkit-vault-large";

/** The vault's durable ctx head — mirrors `spectrolite/app/vaultContext.ts`
 *  (`vault-<fnv1a36>` of the workspace-relative vault root). Kept in sync by
 *  the unit test in that package; replicated here to address the panel's head
 *  from the privileged testkit caller. */
function vaultCtxHead(vaultPath: string): string {
  const input = vaultPath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca77) >>> 0;
    h2 = (h2 + i + 1) >>> 0;
  }
  return `ctx:vault-${h1.toString(36)}${h2.toString(36)}`;
}

const FIXTURES: Record<string, string> = {
  "E2E.mdx": [
    "---",
    "title: E2E",
    "tags: [e2e]",
    "---",
    "",
    "# E2E Note",
    "",
    "A simple note for end-to-end editor interactions.",
    "",
  ].join("\n"),
  "Linked.mdx": ["---", "title: Linked", "---", "", "# Linked", "", "This note points at [[E2E]].", ""].join(
    "\n"
  ),
  "Broken.mdx": [
    "---",
    "title: Broken",
    "---",
    "",
    "# Broken",
    "",
    "This document keeps the editor usable around malformed JSX.",
    "",
    "<BrokenWidget",
    "",
  ].join("\n"),
};

async function ensureVault(dir: string, files: Record<string, string>): Promise<void> {
  const root = dir.replace(/^\/+/, "").replace(/\/+$/, "");
  // Edit-first GAD write: each `write` creates-or-overwrites and commits to the
  // context head in one atomic transition (disk is projected from the head).
  await vcs.applyEdits({
    edits: Object.entries(files).map(([name, content]) => ({
      kind: "write" as const,
      path: `${root}/${name}`,
      content: { kind: "text" as const, text: content },
    })),
  });
}

function largeVaultFiles(): Record<string, string> {
  const files: Record<string, string> = {
    "Hub.mdx": ["---", "title: Large Hub", "---", "", "# Large Hub", "", "Central node.", ""].join("\n"),
  };
  for (let index = 0; index < 60; index += 1) {
    files[`Bulk-${index}.mdx`] = [
      "---",
      `title: Bulk ${index}`,
      "---",
      "",
      `# Bulk-${index}`,
      "",
      "Links back to [[Hub]].",
      "",
    ].join("\n");
  }
  return files;
}

export const spectrolite = suite("spectrolite", { timeoutMs: 120_000 })
  .test("opens a preselected vault and renders the requested document", async () => {
    await ensureVault(VAULT, FIXTURES);
    await withPanel(
      "panels/spectrolite",
      async (handle) => {
        await waitForText(handle, "E2E Note", { timeoutMs: 60_000 });
        const hasEditor = await evalInPanel<boolean>(
          handle,
          `Boolean(document.querySelector('[data-testid="spectrolite-editor"]'))`
        );
        expect(hasEditor, "editor rendered").toBe(true);
        const text = await panelText(handle);
        expect(text, "vault placeholder leakage").not.toContain("/projects/<not-selected-yet>");
      },
      { stateArgs: { repoRoot: VAULT, openPath: "E2E.mdx" } }
    );
  })
  .test("follows wikilinks between notes", async () => {
    await ensureVault(VAULT, FIXTURES);
    await withPanel(
      "panels/spectrolite",
      async (handle) => {
        await waitForText(handle, "points at", { timeoutMs: 60_000 });
        const clicked = await evalInPanel<boolean>(
          handle,
          `(() => {
            const link = Array.from(document.querySelectorAll("a, button, span"))
              .find((node) => node instanceof HTMLElement && node.textContent?.trim() === "E2E"
                && (node.closest("[data-wikilink]") || node.getAttribute("data-wikilink") !== null
                    || node.className.toString().includes("wikilink")));
            const fallback = Array.from(document.querySelectorAll('[data-wikilink], .wikilink'))[0];
            const target = link ?? fallback;
            if (!(target instanceof HTMLElement)) return false;
            target.click();
            return true;
          })()`
        );
        expect(clicked, "wikilink clickable").toBe(true);
        await waitForText(handle, "E2E Note", { timeoutMs: 30_000 });
      },
      { stateArgs: { repoRoot: VAULT, openPath: "Linked.mdx" } }
    );
  })
  .test("stays usable around malformed MDX", async (t) => {
    await ensureVault(VAULT, FIXTURES);
    await withPanel(
      "panels/spectrolite",
      async (handle) => {
        // Malformed JSX is expected to produce console errors — exempt this
        // panel from the supervision auto-watch so they don't fail the test.
        t.supervisor.unwatchPanel(handle.id);
        await waitForText(handle, /usable around malformed JSX|Broken/, { timeoutMs: 60_000 });
        const editable = await waitFor(
          () =>
            evalInPanel<boolean>(
              handle,
              `Boolean(document.querySelector('[contenteditable="true"], [data-testid="spectrolite-editor"]'))`
            ),
          { timeoutMs: 30_000, label: "editor stays interactive" }
        );
        expect(editable, "editor interactive with broken MDX open").toBe(true);
      },
      { stateArgs: { repoRoot: VAULT, openPath: "Broken.mdx" } }
    );
  })
  .test("reconciles a co-editor's edit into the open document (no banner)", async () => {
    // GAD-native: disk is a projection of the vault head. A co-editor (the
    // scribe) advancing the head must reconcile NARROWLY into the live editor —
    // no "changed on disk" banner, no reload prompt (both removed). We simulate
    // the co-editor with a privileged `vcs.applyEdits` against the vault's
    // durable ctx head.
    await ensureVault(VAULT, FIXTURES);
    await withPanel(
      "panels/spectrolite",
      async (handle) => {
        await waitForText(handle, "E2E Note", { timeoutMs: 60_000 });
        const stamp = `co-editor-${Date.now()}`;
        const head = vaultCtxHead(VAULT);
        const docPath = `${VAULT.replace(/^\/+/, "")}/E2E.mdx`;
        const current = await vcs.readFile(head, docPath);
        await vcs.applyEdits({
          head,
          baseStateHash: current?.stateHash,
          edits: [
            {
              kind: "write",
              path: docPath,
              content: {
                kind: "text",
                text: `${FIXTURES["E2E.mdx"]}\nCo-editor marker: ${stamp}\n`,
              },
            },
          ],
        });
        await waitForText(handle, stamp, { timeoutMs: 60_000 });
        // The disk-conflict UX is gone entirely.
        const text = await panelText(handle);
        expect(text, "no disk-conflict banner").not.toContain("changed on disk");
      },
      { stateArgs: { repoRoot: VAULT, openPath: "E2E.mdx" } }
    );
  })
  .test("stays responsive in a larger vault (with CPU profile attached)", async (t) => {
    await ensureVault(LARGE_VAULT, largeVaultFiles());
    await withPanel(
      "panels/spectrolite",
      async (handle) => {
        await waitForText(handle, "Large Hub", { timeoutMs: 90_000 });
        const ref = await profilePanel(handle, async () => {
          const metrics = await evalInPanel<{ responsive: boolean }>(
            handle,
            `(() => {
              const refresh = document.querySelector('[aria-label="Refresh"]');
              if (refresh instanceof HTMLElement) refresh.click();
              return { responsive: Boolean(document.querySelector('[data-testid="spectrolite-editor"]')) };
            })()`
          );
          if (!metrics.responsive) throw new Error("editor unresponsive during refresh");
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        });
        t.log(`cpu profile: ${ref.path} (${ref.summary.totalSamples} samples)`);
      },
      { stateArgs: { repoRoot: LARGE_VAULT, openPath: "Hub.mdx" }, timeoutMs: 90_000 }
    );
  });
