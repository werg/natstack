/**
 * Lock-in test for the shell renderer Content-Security-Policy.
 *
 * The shell runs with `nodeIntegration: true` and `contextIsolation: false`
 * (see src/main/viewManager.ts and GitHub issue #33). Today, no
 * attacker-influenced data reaches an HTML sink in the shell renderer, so
 * the configuration is not exploitable. The CSP in src/renderer/index.html
 * is the page-side enforcement of the invariants that make that true.
 *
 * If this test starts failing, do NOT simply update the expected strings —
 * a regression here probably means a future PR is about to silently widen
 * the shell's XSS surface. Re-audit before relaxing.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(HERE, "index.html"), "utf8");

/**
 * Extract the CSP value from the Content-Security-Policy meta tag.
 *
 * We test against the extracted value rather than the whole HTML so that
 * negative assertions ("no 'unsafe-inline' for scripts") don't accidentally
 * match documentation comments elsewhere in the file. If the meta tag is
 * missing, this returns an empty string and the positive assertions fail.
 */
function extractCsp(html: string): string {
  const match = html.match(/<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"/i);
  return match?.[1] ?? "";
}

describe("shell renderer CSP (issue #33)", () => {
  const csp = extractCsp(INDEX_HTML);

  it("includes a Content-Security-Policy meta tag", () => {
    expect(csp).not.toBe("");
  });

  it("forbids inline and remote scripts (script-src 'self' only)", () => {
    expect(csp).toContain("script-src 'self'");
    // The script-src directive runs until the next semicolon. Isolate it
    // before negative-asserting — the full CSP also contains
    // style-src 'unsafe-inline' which is intentional.
    const scriptSrc = csp.match(/script-src[^;]*/)?.[0] ?? "";
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(scriptSrc).not.toMatch(/\bhttps?:/);
  });

  it("blocks all direct network connections (connect-src 'none')", () => {
    // The shell makes no fetch / WebSocket / EventSource calls — all I/O
    // routes through IPC. If this changes, audit before relaxing.
    expect(csp).toContain("connect-src 'none'");
  });

  it("uses a strict default-src baseline", () => {
    expect(csp).toContain("default-src 'none'");
  });

  it("blocks framing, objects, and form posts", () => {
    expect(csp).toContain("frame-src 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
  });
});
