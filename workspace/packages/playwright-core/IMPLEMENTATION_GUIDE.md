# Playwright Browser-Compatible CDP Client - Implementation Guide

## Status: Phase 1-3 Complete

This document describes the remediation plan implementation status and the approach for completing the Playwright fork for direct CDP usage.

## What's Been Done (Phases 1-3)

### Phase 1: Cleanup & Foundation ✅
- **Removed** `/client/crBrowser.ts` - incompatible custom API
- **Deleted** 40 duplicate `.js` files in `/client/` - esbuild handles TypeScript directly
- **Fixed browser stubs**:
  - `fs.ts` - Added OPFS validation at module load
  - `events.ts` - Maintained simple browser-compatible EventEmitter
  - Created `validateBrowserEnvironment.ts` - Startup validation for required APIs

### Phase 2: CDP Adapter Layer ✅
- **Created** `cdpAdapter.ts` - Core CDP wrapper
  - Wraps CRSession for type-safe CDP protocol calls
  - Provides `evaluate()` and `evaluateWithArg()` methods
  - References InjectedScriptLoader for selector evaluation

- **Created** `frameAdapter.ts` - Frame-specific CDP operations
  - Implements polling-based selector waiting with exponential backoff
  - Methods: `waitForSelector()`, `querySelector()`, `evaluateSelector()`
  - Portable from server-side `frames.ts` logic

### Phase 3: InjectedScript Integration ✅
- **Created** `injectedScriptLoader.ts` - Manages InjectedScript lifecycle
  - Caches InjectedScript per execution context
  - Lazy-loads on first use
  - Provides stub implementation using native DOM APIs
  - Ready for integration with bundled `@workspace/playwright-injected`

- **Updated** `index.ts` exports - Added new CDP utilities to public API

## Architecture Overview

### Current (RPC-based)
```
Client Code
  ↓
Page / Frame (use _channel RPC)
  ↓
Connection / ChannelOwner
  ↓ (WebSocket/IPC)
Server (dispatcher pattern)
  ↓
CDP Browser
```

### Target (CDP-direct)
```
Client Code
  ↓
Page / Frame (use CDPAdapter)
  ↓
CDPAdapter (wraps CRSession)
  ↓ (WebSocket via CDP protocol)
Browser CDP WebSocket
```

## Next Steps: Phase 4+ Migration

### Strategy: Gradual Replacement

Rather than rewriting all classes at once, adapt incrementally:

#### Step 1: Create CDP-backed implementations alongside RPC versions

```typescript
// client/frameImpl.ts - Direct CDP implementation
export class FrameImpl {
  constructor(private adapter: CDPAdapter) {}

  async querySelector(selector: string): Promise<ElementHandle | null> {
    const injected = await this.adapter.getInjectedScriptLoader().getInjectedScript(1);
    // Use injected script directly
    const found = await this.adapter.evaluate({
      expression: `/* CDP call to evaluate selector */`
    });
    return found ? new ElementHandle(this.adapter, found) : null;
  }
}
```

#### Step 2: Adapt Frame class to support both RPC and CDP

```typescript
// client/frame.ts - adapted
export class Frame extends ChannelOwner<channels.FrameChannel> implements api.Frame {
  private _cdpImpl?: FrameImpl;

  // Check if using CDP mode vs RPC mode
  private isCDPMode(): boolean {
    return !!(this as any)._adapter;
  }

  async querySelector(selector: string, options): Promise<ElementHandle | null> {
    if (this.isCDPMode()) {
      return this._cdpImpl!.querySelector(selector);
    }
    // RPC mode (current)
    return this._channel.querySelector(selector);
  }
}
```

### File-by-File Adaptation Path

| File | Type | Approach | Notes |
|------|------|----------|-------|
| `page.ts` | Core | Create `PageImpl` | Handle navigation, goto, screenshot |
| `frame.ts` | Core | Create `FrameImpl` | querySelector, evaluate, waitForSelector |
| `elementHandle.ts` | Core | Adapt | Use CDP object IDs for lifetime management |
| `browserContext.ts` | Core | Create `BrowserContextImpl` | Simplified for single-session model |
| `browser.ts` | Core | Create `BrowserImpl` | Connect and session management |
| `locator.ts` | Selector | Keep mostly as-is | Delegates to Frame/Page methods |
| `connection.ts` | RPC | Keep for compatibility | But route CDP mode to CDPAdapter |

### Key Implementation Details

#### Browser.connect() - CDP Entry Point

```typescript
export class Browser {
  static async connect(wsEndpoint: string): Promise<Browser> {
    // NEW: CDP-direct connection
    const transport = await BrowserWebSocketTransport.connect(wsEndpoint);
    const connection = new CRConnection(...);
    const cdpAdapter = new CDPAdapter(connection.rootSession);

    // OLD: Keep for backward compatibility
    // const browser = new Browser(connection); // RPC mode

    // NEW: CDP mode
    return new BrowserCDP(cdpAdapter);
  }
}

export class BrowserCDP {
  constructor(private adapter: CDPAdapter) {}

  async newPage(): Promise<Page> {
    // Create new target and attach
    const result = await this.adapter.getSession().send('Target.createTarget', {
      url: 'about:blank'
    });

    const page = new PageCDP(new CDPAdapter(childSession));
    return page;
  }
}
```

#### Page.goto() - Navigation Handling

```typescript
export class PageCDP {
  async goto(url: string, options?: GotoOptions): Promise<Response | null> {
    const { waitUntil = 'load', timeout = 30000 } = options ?? {};

    // Wait for page events
    const navigationPromise = this.waitForNavigation(waitUntil, timeout);

    // Trigger navigation
    await this.adapter.getSession().send('Page.navigate', { url });

    // Wait for completion
    await navigationPromise;
    return null; // No Response tracking in CDP mode
  }

  private waitForNavigation(
    waitUntil: 'load' | 'domcontentloaded' | 'networkidle',
    timeout: number
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      let eventName = 'Page.loadEventFired';
      if (waitUntil === 'domcontentloaded') eventName = 'Page.domContentEventFired';

      const session = this.adapter.getSession();
      const listener = () => {
        session.off(eventName, listener);
        resolve();
      };

      session.on(eventName, listener);

      const timeoutId = setTimeout(() => {
        session.off(eventName, listener);
        reject(new TimeoutError(`Navigation timeout`));
      }, timeout);
    });
  }
}
```

## Integration Testing

Once Page/Frame implementations are working:

```typescript
// test/integration.test.ts
import { Browser } from '@workspace/playwright-core';

describe('Browser CDP Client', () => {
  it('should connect and navigate', async () => {
    const browser = await Browser.connect(cdpEndpoint);
    const page = await browser.newPage();

    await page.goto('https://example.com');
    const button = await page.locator('button').first();
    await button.click();

    await browser.close();
  });
});
```

## Testing Strategy

1. **Unit Tests**
   - CDPAdapter evaluation
   - FrameAdapter selector polling
   - InjectedScriptLoader caching

2. **Integration Tests**
   - Browser.connect(wsEndpoint)
   - Page.goto() with different waitUntil options
   - Selector evaluation (getByRole, getByTestId, etc.)
   - Element interactions (click, fill, etc.)
   - Navigation events

3. **API Compatibility Tests**
   - Compare with Playwright test suite
   - Verify Locator API features
   - Test auto-waiting behavior

## Build & Distribution

- Esbuild already configured for browser bundling
- Size target: ~300KB unminified (was 2.6MB)
- Expected gzipped: ~80KB
- Browser stubs handle Node APIs transparently

## Migration Path for Existing Code

### Old Code (RPC-based):
```typescript
const browser = await Browser.connect(endpoint);
const page = await browser.newPage();
```

### New Code (CDP-based, **same API**):
```typescript
const browser = await Browser.connect(endpoint); // Same!
const page = await browser.newPage(); // Same!
```

The internal implementation changes, but the public API remains Playwright-compatible.

---

## File Structure Reference

```
src/
├── client/
│   ├── browser.ts (adapt for CDP)
│   ├── browserContext.ts (adapt)
│   ├── page.ts (adapt)
│   ├── frame.ts (adapt)
│   ├── locator.ts (keep mostly)
│   ├── elementHandle.ts (adapt)
│   ├── cdpAdapter.ts ✅ (NEW)
│   ├── frameAdapter.ts ✅ (NEW)
│   ├── injectedScriptLoader.ts ✅ (NEW)
│   ├── validateBrowserEnvironment.ts ✅ (NEW)
│   ├── eventEmitter.ts (verify)
│   └── [other files]
├── server/
│   ├── chromium/
│   │   ├── crConnection.ts (keep - CDP transport)
│   │   └── protocol.d.ts (keep)
│   └── [other files]
└── browser-stubs/
    ├── fs.ts ✅ (OPFS validation added)
    ├── events.ts (keep - browser compatible)
    └── [other stubs]
```

---

## Estimated Completion

- Phase 4 (Browser/Page CDP impl): 2-3 days
- Phase 5 (Element operations): 2 days
- Phase 6 (Tests & refinement): 2-3 days
- Total remaining: ~7 days

---

## Key Design Principles

1. **API Compatibility**: Public API matches Playwright exactly
2. **Narrow Scope**: One session, one CDP WebSocket, no multi-browser complexity
3. **Internal Freedom**: Internals can diverge significantly from Playwright
4. **Incremental**: Migrate one class at a time, keep RPC path as fallback
5. **Browser-first**: All code must work in browser context (WebSocket, no Node.js modules)
