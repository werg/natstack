import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  detectBrowserPlatform: vi.fn(),
  resolveBuildId: vi.fn(),
  computeExecutablePath: vi.fn(),
  getInstalledBrowsers: vi.fn(),
  install: vi.fn(),
  Browser: {
    CHROME: "chrome",
    CHROMEHEADLESSSHELL: "chrome-headless-shell",
  },
}));

vi.mock("node:child_process", () => ({
  execFileSync: mocks.execFileSync,
}));

vi.mock("@puppeteer/browsers", () => ({
  Browser: mocks.Browser,
  computeExecutablePath: mocks.computeExecutablePath,
  detectBrowserPlatform: mocks.detectBrowserPlatform,
  getInstalledBrowsers: mocks.getInstalledBrowsers,
  install: mocks.install,
  resolveBuildId: mocks.resolveBuildId,
}));

describe("resolveChromium", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-acquire-test-"));
    mocks.execFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    mocks.detectBrowserPlatform.mockReturnValue("linux");
    mocks.resolveBuildId.mockResolvedValue("150.0.7871.24");
    mocks.computeExecutablePath.mockReturnValue(
      path.join(tempDir, "chrome", "linux-150.0.7871.24", "chrome-linux64", "chrome")
    );
    mocks.install.mockResolvedValue({ executablePath: "/downloaded/chrome" });
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("uses an existing managed browser before starting a new stable download", async () => {
    const { resolveChromium } = await import("./browser/acquire.js");
    const cachedPath = path.join(
      tempDir,
      "chrome",
      "linux-149.0.7827.115",
      "chrome-linux64",
      "chrome"
    );
    fs.mkdirSync(path.dirname(cachedPath), { recursive: true });
    fs.writeFileSync(cachedPath, "");
    mocks.getInstalledBrowsers.mockResolvedValue([
      {
        browser: mocks.Browser.CHROME,
        platform: "linux",
        buildId: "149.0.7827.115",
        executablePath: cachedPath,
      },
    ]);

    await expect(resolveChromium({ cacheDir: tempDir })).resolves.toEqual({
      executablePath: cachedPath,
      source: "downloaded",
    });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.resolveBuildId).not.toHaveBeenCalled();
  });

  it("uses an existing managed browser when downloads are disabled", async () => {
    const { resolveChromium } = await import("./browser/acquire.js");
    const cachedPath = path.join(
      tempDir,
      "chrome",
      "linux-149.0.7827.115",
      "chrome-linux64",
      "chrome"
    );
    fs.mkdirSync(path.dirname(cachedPath), { recursive: true });
    fs.writeFileSync(cachedPath, "");
    mocks.getInstalledBrowsers.mockResolvedValue([
      {
        browser: mocks.Browser.CHROME,
        platform: "linux",
        buildId: "149.0.7827.115",
        executablePath: cachedPath,
      },
    ]);

    await expect(resolveChromium({ cacheDir: tempDir, allowDownload: false })).resolves.toEqual({
      executablePath: cachedPath,
      source: "downloaded",
    });
    expect(mocks.install).not.toHaveBeenCalled();
    expect(mocks.resolveBuildId).not.toHaveBeenCalled();
  });
});
