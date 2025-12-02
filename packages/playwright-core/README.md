# 🎭 Playwright - Browser Client Library

> A minimal CDP client library for orchestrating Chrome browser sessions over WebSocket connections.

This is a stripped-down, browser-compatible version of Playwright that **only** includes the client-side CDP orchestration code. It requires an **existing Chrome/Chromium instance with CDP enabled** and connects to it via WebSocket.

## ⚡ What's Different

This is **NOT** the full Playwright framework. It's a minimal client library with:

✅ **What's included:**
- Browser instance management
- Page/context/frame navigation
- Element selection and interaction (Locators)
- Network request interception
- JavaScript execution context
- Input simulation (keyboard, mouse, touch)
- Direct CDP protocol access
- Full TypeScript support

❌ **What's NOT included:**
- Browser launching or process management
- Browser binary detection/installation
- Test framework (@playwright/test)
- CLI tools or commands
- Trace recording to disk
- HTML reports
- Component testing
- Android/Electron automation

## 📦 Installation

```bash
npm install @natstack/playwright-core
```

## 🚀 Quick Start

```typescript
import { connectOverCDP } from '@natstack/playwright-core';

// Start Chrome with CDP enabled:
// chromium --remote-debugging-port=9222

// Connect to the running Chrome instance
const browser = await connectOverCDP('ws://localhost:9222');

// Use standard Playwright APIs
const context = await browser.newContext();
const page = await context.newPage();
await page.goto('https://example.com');

// Interact with the page
await page.click('button');
const title = await page.title();
console.log(title);

// Take a screenshot
await page.screenshot({ path: 'screenshot.png' });

await browser.close();
```

## 📝 Examples

### Navigate and wait for elements

```typescript
const page = await context.newPage();
await page.goto('https://example.com');
await page.waitForSelector('h1');
const heading = await page.textContent('h1');
```

### Element interaction with Locators

```typescript
// Find elements with locators
const button = page.locator('button:has-text("Submit")');
await button.click();

// Fill form fields
await page.locator('input[name="email"]').fill('test@example.com');
```

### Network interception

```typescript
// Route network requests
await page.route('**/*.jpg', route => route.abort());
await page.route('/api/**', async route => {
  // Modify request
  await route.continue();
});
```

### JavaScript execution

```typescript
// Evaluate code in page context
const result = await page.evaluate(() => {
  return document.documentElement.innerHTML;
});

// Pass arguments to evaluated code
const sum = await page.evaluate((a, b) => a + b, 1, 2);
```

### Direct CDP access

```typescript
// Get raw CDP session for advanced features
const cdpSession = await page.context().cdpSession();

// Send raw CDP commands
await cdpSession.send('Network.clearBrowserCache');
```

## 🏗️ Project Structure

```
packages/
├── playwright-core/     (2.6 MB) - Main browser client library (@natstack/playwright-core)
├── protocol/            (256 KB) - Protocol definitions (@natstack/playwright-protocol)
├── injected/            (532 KB) - Browser-injected scripts (@natstack/playwright-injected)
└── playwright-client/   (960 KB) - Thin wrapper (@natstack/playwright-client)
```

## 📚 API Surface

### Browser Management
- `Browser` - Browser instance
- `BrowserContext` - Incognito profiles
- `Page` - Web page
- `Frame` - Page frame or iframe

### Element Interaction
- `Locator` - Element finder (recommended)
- `ElementHandle` - Direct DOM element reference
- `Keyboard`, `Mouse`, `Touchscreen` - Input simulation

### Network & Requests
- `Request`, `Response` - HTTP messages
- `Route` - Request routing/interception
- `WebSocket` - WebSocket connections

### Advanced
- `CDPSession` - Raw CDP protocol access
- `JSHandle` - JavaScript value wrapper
- `Dialog` - Alert/Confirm/Prompt handling
- `Worker` - Web worker management

## 🔌 Dependencies

This library has **zero Node.js-specific dependencies**:

- `ws` - WebSocket communication
- `xml2js` - XML parsing
- `yaml` - YAML parsing
- `zod` - Schema validation
- `chromium-bidi` - BiDi protocol support
- `typescript` - Type checking

## 📖 Documentation

For detailed API documentation and examples, see [Playwright API Reference](https://playwright.dev/docs/api/class-playwright).

Note: The full documentation at playwright.dev includes server-side features not available in this client-only library.

## 🛠️ Available Commands

```bash
# Type check all packages
npm run tsc

# Generate protocol code (rarely needed)
npm run generate-channels

# Bundle injected scripts (rarely needed)
npm run generate-injected
```

## 🌐 Browser Setup

### Chrome/Chromium

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-data

# Linux
google-chrome \
  --remote-debugging-port=9222 \
  --user-data-dir=/tmp/chrome-data

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" ^
  --remote-debugging-port=9222 ^
  --user-data-dir=%temp%\chrome-data
```

### Puppeteer Server

Or use Puppeteer server for automatic browser management:

```bash
npx @puppeteer/browsers launch chrome@stable --detach
```

Then connect to its CDP port.

## 📋 Size & Performance

- **Core library:** 2.6 MB
- **All packages:** 4.3 MB
- **Dependencies:** 8 npm packages (0 Node.js-specific)
- **Browser compatible:** Yes
- **Requires Node.js:** No (except for CLI tools)

## 🔒 Security

This library:
- Connects only to **explicitly provided** CDP WebSocket URLs
- Does **not** launch or control browser processes
- Has **no file system access**
- Cannot install browser binaries
- Cannot run arbitrary commands

## 📄 License

Apache 2.0 - See LICENSE file

## 🤝 Contributing

This is a minimal client library extracted from [Playwright](https://github.com/microsoft/playwright) and maintained by [NatStack](https://github.com/natstack). For full Playwright development, see the original [Playwright repository](https://github.com/microsoft/playwright).

## 📚 Resources

- [Playwright Official Documentation](https://playwright.dev)
- [CDP Specification](https://chromedevtools.github.io/devtools-protocol/)
- [Original Playwright Repository](https://github.com/microsoft/playwright)

---

**This library version is optimized for:**
- Browser-based automation (e.g., running in a Node.js backend or Electron app)
- Connecting to existing Chrome instances
- Minimal dependencies and footprint
- Full TypeScript support with complete types
