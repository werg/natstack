# Playwright Core CDP-Direct Usage Examples

## Overview

The Playwright Core library now supports **CDP-direct mode** with full Playwright API compatibility. This mode connects directly to a Chrome instance via CDP WebSocket without requiring a Playwright server.

## Basic Usage

### Connecting to a Browser

```typescript
import { BrowserImpl } from '@workspace/playwright-core';

// Connect to Chrome via CDP WebSocket
const browser = await BrowserImpl.connect('ws://localhost:9222/devtools/browser/...');

// Create a new page
const page = await browser.newPage();

// Navigate to a URL
await page.goto('https://example.com');

// Get page title
const title = await page.title();
console.log('Page title:', title);

// Close browser
await browser.close();
```

### Navigation and Waiting

```typescript
// Navigate with different wait strategies
await page.goto('https://example.com', { waitUntil: 'load' });
await page.goto('https://example.com', { waitUntil: 'domcontentloaded' });

// Wait for selector
await page.waitForSelector('button.submit', {
  state: 'visible',
  timeout: 5000
});
```

### Interacting with Elements

```typescript
// Click an element
await page.click('button.submit');

// Fill input fields
await page.fill('input[name="email"]', 'user@example.com');
await page.fill('input[name="password"]', 'mypassword');

// Type text (same as fill for now)
await page.type('textarea', 'Hello world');
```

### Evaluating JavaScript

```typescript
// Evaluate expression
const result = await page.evaluate(() => {
  return document.querySelector('h1')?.textContent;
});

// Evaluate with arguments
const count = await page.evaluate((selector) => {
  return document.querySelectorAll(selector).length;
}, 'div.item');
```

### Taking Screenshots

```typescript
// Take PNG screenshot
const screenshot = await page.screenshot({ format: 'png' });

// Take JPEG with quality
const screenshot = await page.screenshot({
  format: 'jpeg',
  quality: 80
});

// Save to file (if in Node.js environment)
// In browser, you would convert Uint8Array to blob
```

### Getting Page Content

```typescript
// Get full HTML content
const html = await page.content();

// Get URL
const url = page.url();
```

## Advanced Usage

### Multiple Contexts

```typescript
const browser = await BrowserImpl.connect(wsEndpoint);

// Create isolated browsing context
const context = await browser.newContext();
const page = await context.newPage();

await page.goto('https://example.com');

// Close context (closes all pages)
await context.close();
```

### Direct Frame Access

```typescript
// Access main frame directly
const frame = page.mainFrame();

// Wait for selector in frame
await frame.waitForSelector('.content');

// Evaluate in frame
const data = await frame.evaluate(() => {
  return document.body.dataset.info;
});
```

### Using CDP Adapter Directly

```typescript
// For advanced use cases, access CDP adapter
const adapter = page._getAdapter();

// Evaluate with custom options
const result = await adapter.evaluate({
  expression: 'window.navigator.userAgent',
  returnByValue: true,
  awaitPromise: false
});
```

## Environment Setup

### Browser Requirements

The library requires:
- **WebSocket API** - For CDP communication
- **Web Crypto API** - For cryptographic operations
- **Filesystem** - Injected as `globalThis.fs` (RPC-backed in safe panels)

### Validation

```typescript
import { validateBrowserEnvironment } from '@workspace/playwright-core';

// Validate environment before connecting
try {
  validateBrowserEnvironment();
  console.log('Environment is ready');
} catch (error) {
  console.error('Missing required APIs:', error.message);
}
```

## Comparison with Standard Playwright

### Same Public API ✅

```typescript
// Standard Playwright
const browser = await playwright.chromium.connect(wsEndpoint);
const page = await browser.newPage();
await page.goto('https://example.com');
await page.click('button');
await browser.close();

// CDP-Direct Mode (same API!)
const browser = await BrowserImpl.connect(wsEndpoint);
const page = await browser.newPage();
await page.goto('https://example.com');
await page.click('button');
await browser.close();
```

### Key Differences

| Feature | Standard Playwright | CDP-Direct Mode |
|---------|---------------------|-----------------|
| Connection | Server required | Direct CDP WebSocket |
| API | Full Playwright API | Core API subset |
| Browser Support | Multi-browser | Chrome/Chromium only |
| Network intercept | Full support | Limited (CDP-level) |
| Tracing | Full support | Not supported |
| Codegen | Full support | Not supported |
| Size | ~10MB | 521KB (80KB gzipped) |
| Platform | Node.js | Browser + Node.js |

## Error Handling

```typescript
import { TimeoutError } from '@workspace/playwright-core';

try {
  await page.goto('https://example.com', { timeout: 5000 });
} catch (error) {
  if (error instanceof TimeoutError) {
    console.error('Navigation timed out');
  } else {
    console.error('Navigation failed:', error.message);
  }
}
```

## Timeout Configuration

```typescript
// Set default timeout for all operations
page.setDefaultTimeout(10000); // 10 seconds

// Set navigation-specific timeout
page.setDefaultNavigationTimeout(30000); // 30 seconds

// Frame-level timeout
const frame = page.mainFrame();
frame.setDefaultTimeout(5000);
```

## Complete Example

```typescript
import { BrowserImpl, validateBrowserEnvironment } from '@workspace/playwright-core';

async function main() {
  // Validate environment
  validateBrowserEnvironment();

  // Connect to browser
  const browser = await BrowserImpl.connect('ws://localhost:9222/devtools/browser/...');

  try {
    // Create page
    const page = await browser.newPage();

    // Set timeout
    page.setDefaultTimeout(10000);

    // Navigate
    await page.goto('https://example.com');

    // Wait for content
    await page.waitForSelector('.content', { state: 'visible' });

    // Interact
    await page.fill('input[name="search"]', 'playwright');
    await page.click('button[type="submit"]');

    // Wait for results
    await page.waitForSelector('.results', { state: 'visible' });

    // Extract data
    const results = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.result'))
        .map(el => el.textContent?.trim())
        .filter(Boolean);
    });

    console.log('Results:', results);

    // Take screenshot
    const screenshot = await page.screenshot({ format: 'png' });
    console.log('Screenshot size:', screenshot.length);

  } finally {
    // Always close
    await browser.close();
  }
}

main().catch(console.error);
```

## Migration from Old Fork

If you were using the old `CRBrowser` API:

### Before (Old API)
```typescript
import { CRBrowser } from '@workspace/playwright-core';

const browser = await CRBrowser.connect(wsEndpoint);
const page = browser.defaultContext().pages()[0];
await page.goto(url);
```

### After (New CDP-Direct API)
```typescript
import { BrowserImpl } from '@workspace/playwright-core';

const browser = await BrowserImpl.connect(wsEndpoint);
const page = await browser.newPage();
await page.goto(url);
```

## Next Steps

- See [IMPLEMENTATION_GUIDE.md](./IMPLEMENTATION_GUIDE.md) for architecture details
- See [REMEDIATION_SUMMARY.md](./REMEDIATION_SUMMARY.md) for complete implementation status
- Check the TypeScript definitions in `dist/client/*.d.ts` for full API reference
