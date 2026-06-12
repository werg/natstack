/**
 * Spectrolite suite — in-system port of the core tests from
 * tests/e2e/flows/spectrolite.spec.ts.
 *
 * The outside spec builds vault fixtures on the host filesystem before
 * launching Electron; here the fixture vault is created in context fs via the
 * runtime git client, and the panel is opened with the same stateArgs
 * ({ repoRoot, openPath }). DOM interaction goes through CDP (driver DO
 * route for workspace panels).
 *
 * Not ported (still outside-only): first-run vault picker + agent add/remove
 * + vault switching (deep dialog flows tied to channel agents), commit/flush
 * keyboard editing flows (Electron input events), mobile-viewport variant
 * (covered generically by the panel-viewport suite).
 */
import { fs, git } from "@workspace/runtime";
import { suite } from "../run.js";
import { expect } from "../expect.js";
import { evalInPanel, panelText, waitFor, waitForText, withPanel } from "../panels.js";
import { profilePanel } from "../profile.js";

const VAULT = "/projects/testkit-vault";
const LARGE_VAULT = "/projects/testkit-vault-large";

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
  const marker = `${dir}/.git`;
  const exists = await fs
    .stat(marker)
    .then(() => true)
    .catch(() => false);
  await fs.mkdir(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    await fs.writeFile(`${dir}/${name}`, content);
  }
  const client = git.client();
  if (!exists) await client.init(dir, "main");
  await client.addAll(dir);
  const status = await client.status(dir);
  if (status.files.some((file) => file.status !== "unmodified" && file.status !== "ignored")) {
    await client.commit(dir, "testkit vault fixture", {
      name: "testkit",
      email: "testkit@natstack.local",
    });
  }
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
  .test("surfaces external writes to the open document", async () => {
    await ensureVault(VAULT, FIXTURES);
    await withPanel(
      "panels/spectrolite",
      async (handle) => {
        await waitForText(handle, "E2E Note", { timeoutMs: 60_000 });
        const stamp = `external-edit-${Date.now()}`;
        await fs.writeFile(
          `${VAULT}/E2E.mdx`,
          `${FIXTURES["E2E.mdx"]}\nExternal change marker: ${stamp}\n`
        );
        await waitForText(handle, new RegExp(`${stamp}|changed on disk|Reload`), {
          timeoutMs: 60_000,
        });
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
