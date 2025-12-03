/**
 * Validates that required browser APIs are available.
 * Call this at library initialization to fail fast with clear errors.
 */
export function validateBrowserEnvironment(): void {
  const missing: string[] = [];

  // WebSocket is required for CDP communication
  if (typeof WebSocket === 'undefined') {
    missing.push('WebSocket');
  }

  // Web Crypto is used for cryptographic operations
  if (!globalThis.crypto?.subtle) {
    missing.push('crypto.subtle');
  }

  // OPFS fs is critical for file operations in the browser
  if (!(globalThis as any).fs) {
    missing.push('globalThis.fs (OPFS)');
  }

  if (missing.length) {
    const list = missing.join(', ');
    throw new Error(
      `Playwright browser library initialization failed. Missing required APIs: ${list}\n\n` +
      'This library requires:\n' +
      '- WebSocket API\n' +
      '- Web Crypto API\n' +
      '- OPFS FileSystem API (injected as globalThis.fs)\n'
    );
  }
}
