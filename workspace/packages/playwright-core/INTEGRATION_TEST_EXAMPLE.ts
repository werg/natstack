/**
 * Internal BrowserImpl smoke examples.
 *
 * Userland code should import @workspace/playwright-automation and call
 * playwrightPage(handle). This file stays inside @workspace/playwright-core to
 * document the lower-level implementation path used by package internals.
 */

import { BrowserImpl, validateBrowserEnvironment } from '@workspace/playwright-core';

type CdpEndpoint = { wsEndpoint: string; token?: string };
type Browser = Awaited<ReturnType<typeof BrowserImpl.connect>>;
type Page = ReturnType<Browser['contexts']>[number] extends infer Context
  ? Context extends { pages(): Array<infer P> }
    ? P
    : never
  : never;

async function connectBrowser(cdpEndpoint: CdpEndpoint): Promise<Browser> {
  return BrowserImpl.connect(cdpEndpoint.wsEndpoint, {
    isElectronWebview: true,
    transportOptions: cdpEndpoint.token ? { authToken: cdpEndpoint.token } : undefined,
  });
}

function existingPage(browser: Browser): Page {
  const page = browser.contexts()[0]?.pages()[0];
  if (!page) throw new Error('No page found in CDP target');
  return page;
}

/**
 * Test 1: connect to the existing Electron webview page and navigate it.
 */
export async function testBasicNavigation(cdpEndpoint: CdpEndpoint) {
  console.log('Test 1: Basic Connection and Navigation');

  const browser = await connectBrowser(cdpEndpoint);
  console.log(`Connected to browser: ${browser.version()}`);

  const page = existingPage(browser);
  await page.goto('https://example.com', { waitUntil: 'load' });
  console.log(`Navigated to: ${page.url()}`);

  const title = await page.title();
  console.log(`Page title: "${title}"`);

  await browser.close();
}

/**
 * Test 2: evaluate JavaScript in the existing page.
 */
export async function testJavaScriptEvaluation(cdpEndpoint: CdpEndpoint) {
  console.log('\nTest 2: JavaScript Evaluation');

  const browser = await connectBrowser(cdpEndpoint);
  const page = existingPage(browser);

  await page.goto('https://example.com');

  const result = await page.evaluate(() => document.title);
  console.log(`Evaluated expression: "${result}"`);

  const sum = await page.evaluate((a, b) => a + b, 5, 10);
  console.log(`Evaluated with args: 5 + 10 = ${sum}`);

  const pageData = await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
    elementCount: document.querySelectorAll('*').length,
    hasH1: !!document.querySelector('h1'),
    headingText: document.querySelector('h1')?.textContent || null,
  }));
  console.log('Extracted page data:', JSON.stringify(pageData, null, 2));

  await browser.close();
}

/**
 * Test 3: selectors and form interaction on the existing page.
 */
export async function testElementInteraction(cdpEndpoint: CdpEndpoint) {
  console.log('\nTest 3: Element Selection and Interaction');

  const browser = await connectBrowser(cdpEndpoint);
  const page = existingPage(browser);

  await page.goto('https://httpbin.org/forms/post');

  const hasForm = await page.querySelector('form');
  console.log(`Found form element: ${hasForm}`);

  await page.fill('input[name="custname"]', 'Test User');
  await page.type('input[name="custtel"]', '123-456-7890');

  const values = await page.evaluate(() => {
    const nameInput = document.querySelector('input[name="custname"]') as HTMLInputElement;
    const phoneInput = document.querySelector('input[name="custtel"]') as HTMLInputElement;
    return {
      name: nameInput?.value,
      phone: phoneInput?.value,
    };
  });
  console.log('Verified input values:', values);

  await browser.close();
}

/**
 * Test 4: wait for selectors and expected selector failures.
 */
export async function testWaitForSelector(cdpEndpoint: CdpEndpoint) {
  console.log('\nTest 4: Wait for Selector');

  const browser = await connectBrowser(cdpEndpoint);
  const page = existingPage(browser);

  await page.goto('https://example.com');

  const found = await page.waitForSelector('h1', {
    state: 'visible',
    timeout: 5000,
  });
  console.log(`Waited for h1 element: ${found}`);

  try {
    await page.waitForSelector('.nonexistent-class', {
      state: 'visible',
      timeout: 1000,
    });
    console.log('Should have timed out');
  } catch {
    console.log('Correctly timed out for nonexistent element');
  }

  await browser.close();
}

/**
 * Test 5: screenshot capture from the existing page.
 */
export async function testScreenshot(cdpEndpoint: CdpEndpoint) {
  console.log('\nTest 5: Screenshot Capture');

  const browser = await connectBrowser(cdpEndpoint);
  const page = existingPage(browser);

  await page.goto('https://example.com');

  const pngData = await page.screenshot({ format: 'png' });
  console.log(`Captured PNG screenshot: ${pngData.length} bytes`);

  const jpegData = await page.screenshot({
    format: 'jpeg',
    quality: 80,
  });
  console.log(`Captured JPEG screenshot: ${jpegData.length} bytes`);

  await browser.close();
}

/**
 * Test 6: content and frame access on the existing page.
 */
export async function testPageContentAndFrame(cdpEndpoint: CdpEndpoint) {
  console.log('\nTest 6: Page Content and Frame Access');

  const browser = await connectBrowser(cdpEndpoint);
  const page = existingPage(browser);

  await page.goto('https://example.com');

  const html = await page.content();
  console.log(`Retrieved HTML content: ${html.length} characters`);

  const frame = page.mainFrame();
  const frameResult = await frame.evaluate(() => ({
    url: window.location.href,
    title: document.title,
  }));
  console.log('Evaluated in frame:', frameResult);

  await browser.close();
}

/**
 * Test 7: error handling on the existing page.
 */
export async function testErrorHandling(cdpEndpoint: CdpEndpoint) {
  console.log('\nTest 7: Error Handling');

  const browser = await connectBrowser(cdpEndpoint);
  const page = existingPage(browser);

  try {
    await page.goto('https://httpbin.org/delay/10', { timeout: 2000 });
    console.log('Should have timed out');
  } catch {
    console.log('Navigation timeout handled correctly');
  }

  try {
    await page.waitForSelector('[[[invalid', { timeout: 1000 });
    console.log('Should have failed');
  } catch {
    console.log('Invalid selector handled correctly');
  }

  try {
    await page.evaluate(() => {
      throw new Error('Test error');
    });
    console.log('Should have thrown');
  } catch {
    console.log('Evaluation error handled correctly');
  }

  await browser.close();
}

/**
 * Test 8: comprehensive real-world workflow on the existing page.
 */
export async function testRealWorldWorkflow(cdpEndpoint: CdpEndpoint) {
  console.log('\nTest 8: Comprehensive Real-World Workflow');

  validateBrowserEnvironment();
  console.log('Environment validated');

  const browser = await connectBrowser(cdpEndpoint);
  console.log(`Connected: ${browser.version()}`);

  const page = existingPage(browser);
  page.setDefaultTimeout(10000);

  await page.goto('https://httpbin.org/html');
  console.log('Navigated to test page');

  const pageAnalysis = await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3')).map(el => ({
      level: el.tagName.toLowerCase(),
      text: el.textContent?.trim() || '',
    }));

    const paragraphs = Array.from(document.querySelectorAll('p'))
      .map(el => el.textContent?.trim() || '')
      .filter(Boolean);

    return {
      url: window.location.href,
      title: document.title,
      headings,
      paragraphCount: paragraphs.length,
    };
  });

  console.log('Page analysis complete:');
  console.log(JSON.stringify(pageAnalysis, null, 2));

  const screenshot = await page.screenshot({ format: 'png' });
  console.log(`Screenshot captured: ${screenshot.length} bytes`);

  await page.goto('https://example.com');
  console.log(`Navigated to: ${page.url()}`);

  const content = await page.content();
  console.log(`Retrieved content: ${content.length} characters`);

  await browser.close();
}

/**
 * Run all tests sequentially.
 */
export async function runAllTests(cdpEndpoint: CdpEndpoint) {
  console.log('='.repeat(60));
  console.log('Running Internal BrowserImpl Smoke Tests');
  console.log('='.repeat(60));

  const tests = [
    testBasicNavigation,
    testJavaScriptEvaluation,
    testElementInteraction,
    testWaitForSelector,
    testScreenshot,
    testPageContentAndFrame,
    testErrorHandling,
    testRealWorldWorkflow,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test(cdpEndpoint);
      passed++;
      console.log(`\n${test.name} PASSED\n`);
    } catch (error) {
      failed++;
      console.error(`\n${test.name} FAILED:`);
      console.error(error);
      console.log();
    }
  }

  console.log('='.repeat(60));
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
}

/**
 * Example usage from a panel:
 *
 * ```ts
 * import { panelTree } from '@workspace/runtime';
 * import { runAllTests } from './INTEGRATION_TEST_EXAMPLE';
 *
 * const endpoint = await panelTree.self().cdp.getCdpEndpoint();
 * await runAllTests(endpoint);
 * ```
 */
