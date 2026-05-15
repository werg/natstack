export function isDev(): boolean {
  return process.env["NODE_ENV"] === "development";
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Assert that a URL is a safe http or https URL.
 *
 * Allow-list approach: only `http:` and `https:` schemes pass.
 * Any other scheme (file:, javascript:, chrome:, chrome-extension:, data:,
 * about:, etc.) is rejected to prevent exfiltration and code injection via
 * browser.navigate / natstack:navigate / view.browserNavigate.
 *
 * @throws {Error} with a descriptive message when the URL is rejected.
 */
export function assertHttpUrl(url: unknown): asserts url is string {
  if (typeof url !== "string" || !/^https?:\/\//i.test(url)) {
    throw new Error(`Invalid URL (only http and https are allowed): ${String(url)}`);
  }
}
