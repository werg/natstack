/**
 * Comprehensive Integration Test Examples for BrowserImpl
 *
 * This file demonstrates all features of the new CDP-direct implementation
 * for use in Electron panel applications like natstack.
 */

import { BrowserImpl, validateBrowserEnvironment } from '@workspace/playwright-core';

/**
 * Test 1: Basic Connection and Navigation
 */
export async function testBasicNavigation(cdpEndpoint: string) {
  console.log('Test 1: Basic Connection and Navigation');

  const browser = await BrowserImpl.connect(cdpEndpoint);
  console.log(`✓ Connected to browser: ${browser.version()}`);

  const page = await browser.newPage();
  console.log('✓ Created new page');

  await page.goto('https://example.com', { waitUntil: 'load' });
  console.log(`✓ Navigated to: ${page.url()}`);

  const title = await page.title();
  console.log(`✓ Page title: "${title}"`);

  await browser.close();
  console.log('✓ Browser closed');
}

/**
 * Test 2: JavaScript Evaluation
 */
export async function testJavaScriptEvaluation(cdpEndpoint: string) {
  console.log('\nTest 2: JavaScript Evaluation');

  const browser = await BrowserImpl.connect(cdpEndpoint);
  const page = await browser.newPage();

  await page.goto('https://example.com');

  // Simple expression evaluation
  const result = await page.evaluate(() => {
    return document.title;
  });
  console.log(`✓ Evaluated expression: "${result}"`);

  // Evaluation with arguments
  const sum = await page.evaluate((a, b) => {
    return a + b;
  }, 5, 10);
  console.log(`✓ Evaluated with args: 5 + 10 = ${sum}`);

  // Complex data extraction
  const pageData = await page.evaluate(() => ({
    url: window.location.href,
    title: document.title,
    elementCount: document.querySelectorAll('*').length,
    hasH1: !!document.querySelector('h1'),
    headingText: document.querySelector('h1')?.textContent || null,
  }));
  console.log('✓ Extracted page data:', JSON.stringify(pageData, null, 2));

  await browser.close();
}

/**
 * Test 3: Element Selection and Interaction
 */
export async function testElementInteraction(cdpEndpoint: string) {
  console.log('\nTest 3: Element Selection and Interaction');

  const browser = await BrowserImpl.connect(cdpEndpoint);
  const page = await browser.newPage();

  // Navigate to a page with forms
  await page.goto('https://httpbin.org/forms/post');

  // Test querySelector
  const hasForm = await page.querySelector('form');
  console.log(`✓ Found form element: ${hasForm}`);

  // Test fill (input field)
  await page.fill('input[name="custname"]', 'Test User');
  console.log('✓ Filled customer name input');

  // Test type
  await page.type('input[name="custtel"]', '123-456-7890');
  console.log('✓ Typed phone number');

  // Verify the values were set
  const values = await page.evaluate(() => {
    const nameInput = document.querySelector('input[name="custname"]') as HTMLInputElement;
    const phoneInput = document.querySelector('input[name="custtel"]') as HTMLInputElement;
    return {
      name: nameInput?.value,
      phone: phoneInput?.value,
    };
  });
  console.log('✓ Verified input values:', values);

  await browser.close();
}

/**
 * Test 4: Wait for Selector
 */
export async function testWaitForSelector(cdpEndpoint: string) {
  console.log('\nTest 4: Wait for Selector');

  const browser = await BrowserImpl.connect(cdpEndpoint);
  const page = await browser.newPage();

  await page.goto('https://example.com');

  // Wait for element to be visible
  const found = await page.waitForSelector('h1', {
    state: 'visible',
    timeout: 5000,
  });
  console.log(`✓ Waited for h1 element: ${found}`);

  // Wait for element that doesn't exist (should timeout)
  try {
    await page.waitForSelector('.nonexistent-class', {
      state: 'visible',
      timeout: 1000,
    });
    console.log('✗ Should have timed out');
  } catch (error) {
    console.log('✓ Correctly timed out for nonexistent element');
  }

  await browser.close();
}

/**
 * Test 5: Screenshot Capture
 */
export async function testScreenshot(cdpEndpoint: string) {
  console.log('\nTest 5: Screenshot Capture');

  const browser = await BrowserImpl.connect(cdpEndpoint);
  const page = await browser.newPage();

  await page.goto('https://example.com');

  // PNG screenshot
  const pngData = await page.screenshot({ format: 'png' });
  console.log(`✓ Captured PNG screenshot: ${pngData.length} bytes`);

  // JPEG screenshot with quality
  const jpegData = await page.screenshot({
    format: 'jpeg',
    quality: 80,
  });
  console.log(`✓ Captured JPEG screenshot: ${jpegData.length} bytes`);

  await browser.close();
}

/**
 * Test 6: Multiple Pages
 */
export async function testMultiplePages(cdpEndpoint: string) {
  console.log('\nTest 6: Multiple Pages');

  const browser = await BrowserImpl.connect(cdpEndpoint);

  // Create multiple pages
  const page1 = await browser.newPage();
  const page2 = await browser.newPage();
  const page3 = await browser.newPage();

  console.log('✓ Created 3 pages');

  // Navigate each to different URLs
  await Promise.all([
    page1.goto('https://example.com'),
    page2.goto('https://httpbin.org/html'),
    page3.goto('https://www.iana.org'),
  ]);
  console.log('✓ Navigated all pages in parallel');

  // Get titles
  const titles = await Promise.all([
    page1.title(),
    page2.title(),
    page3.title(),
  ]);
  console.log('✓ Page titles:', titles);

  // Verify URLs
  console.log('✓ Page 1 URL:', page1.url());
  console.log('✓ Page 2 URL:', page2.url());
  console.log('✓ Page 3 URL:', page3.url());

  await browser.close();
}

/**
 * Test 7: Browser Context
 */
export async function testBrowserContext(cdpEndpoint: string) {
  console.log('\nTest 7: Browser Context');

  const browser = await BrowserImpl.connect(cdpEndpoint);

  // Default context
  const defaultContext = browser.defaultContext();
  console.log('✓ Got default context');

  const page1 = await defaultContext.newPage();
  await page1.goto('https://example.com');
  console.log('✓ Created page in default context');

  // New isolated context
  const context2 = await browser.newContext();
  console.log('✓ Created new isolated context');

  const page2 = await context2.newPage();
  await page2.goto('https://httpbin.org/html');
  console.log('✓ Created page in isolated context');

  // Verify contexts
  const allContexts = browser.contexts();
  console.log(`✓ Total contexts: ${allContexts.length}`);

  // Close isolated context
  await context2.close();
  console.log('✓ Closed isolated context');

  await browser.close();
}

/**
 * Test 8: Page Content Retrieval
 */
export async function testPageContent(cdpEndpoint: string) {
  console.log('\nTest 8: Page Content Retrieval');

  const browser = await BrowserImpl.connect(cdpEndpoint);
  const page = await browser.newPage();

  await page.goto('https://example.com');

  // Get full HTML content
  const html = await page.content();
  console.log(`✓ Retrieved HTML content: ${html.length} characters`);
  console.log(`✓ Content starts with: ${html.substring(0, 50)}...`);

  // Get URL
  const url = page.url();
  console.log(`✓ Current URL: ${url}`);

  // Get title
  const title = await page.title();
  console.log(`✓ Page title: "${title}"`);

  await browser.close();
}

/**
 * Test 9: Frame Access
 */
export async function testFrameAccess(cdpEndpoint: string) {
  console.log('\nTest 9: Frame Access');

  const browser = await BrowserImpl.connect(cdpEndpoint);
  const page = await browser.newPage();

  await page.goto('https://example.com');

  // Access main frame
  const frame = page.mainFrame();
  console.log('✓ Got main frame');

  // Evaluate in frame
  const frameResult = await frame.evaluate(() => {
    return {
      url: window.location.href,
      title: document.title,
    };
  });
  console.log('✓ Evaluated in frame:', frameResult);

  // Frame URL
  const frameUrl = frame.url();
  console.log(`✓ Frame URL: ${frameUrl}`);

  await browser.close();
}

/**
 * Test 10: Error Handling
 */
export async function testErrorHandling(cdpEndpoint: string) {
  console.log('\nTest 10: Error Handling');

  const browser = await BrowserImpl.connect(cdpEndpoint);
  const page = await browser.newPage();

  // Test navigation timeout
  try {
    await page.goto('https://httpbin.org/delay/10', { timeout: 2000 });
    console.log('✗ Should have timed out');
  } catch (error) {
    console.log('✓ Navigation timeout handled correctly');
  }

  // Test invalid selector
  try {
    await page.waitForSelector('[[[invalid', { timeout: 1000 });
    console.log('✗ Should have failed');
  } catch (error) {
    console.log('✓ Invalid selector handled correctly');
  }

  // Test evaluation error
  try {
    await page.evaluate(() => {
      throw new Error('Test error');
    });
    console.log('✗ Should have thrown');
  } catch (error) {
    console.log('✓ Evaluation error handled correctly');
  }

  await browser.close();
}

/**
 * Test 11: Existing Page Connection
 */
export async function testExistingPageConnection(cdpEndpoint: string) {
  console.log('\nTest 11: Existing Page Connection');

  const browser = await BrowserImpl.connect(cdpEndpoint);
  console.log('✓ Connected to browser');

  // Get existing pages (from browser that was already open)
  const context = browser.defaultContext();
  const pages = context.pages();
  console.log(`✓ Found ${pages.length} existing page(s)`);

  if (pages.length > 0) {
    const page = pages[0];
    console.log(`✓ Using existing page: ${page.url()}`);

    // Navigate existing page
    await page.goto('https://example.com');
    console.log('✓ Navigated existing page');

    const title = await page.title();
    console.log(`✓ Page title: "${title}"`);
  }

  await browser.close();
}

/**
 * Test 12: Comprehensive Real-World Workflow
 */
export async function testRealWorldWorkflow(cdpEndpoint: string) {
  console.log('\nTest 12: Comprehensive Real-World Workflow');

  // Validate environment first
  validateBrowserEnvironment();
  console.log('✓ Environment validated');

  const browser = await BrowserImpl.connect(cdpEndpoint);
  console.log(`✓ Connected: ${browser.version()}`);

  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  console.log('✓ Created page with 10s timeout');

  // Navigate to test site
  await page.goto('https://httpbin.org/html');
  console.log('✓ Navigated to test page');

  // Extract structured data
  const pageAnalysis = await page.evaluate(() => {
    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .map(el => ({
        level: el.tagName.toLowerCase(),
        text: el.textContent?.trim() || '',
      }));

    const paragraphs = Array.from(document.querySelectorAll('p'))
      .map(el => el.textContent?.trim() || '')
      .filter(Boolean);

    const links = Array.from(document.querySelectorAll('a'))
      .map(el => ({
        href: (el as HTMLAnchorElement).href,
        text: el.textContent?.trim() || '',
      }));

    return {
      url: window.location.href,
      title: document.title,
      headings,
      paragraphCount: paragraphs.length,
      linkCount: links.length,
      links: links.slice(0, 3), // First 3 links
    };
  });

  console.log('✓ Page analysis complete:');
  console.log(JSON.stringify(pageAnalysis, null, 2));

  // Take screenshot
  const screenshot = await page.screenshot({ format: 'png' });
  console.log(`✓ Screenshot captured: ${screenshot.length} bytes`);

  // Navigate to another page
  await page.goto('https://example.com');
  console.log(`✓ Navigated to: ${page.url()}`);

  // Get final content
  const content = await page.content();
  console.log(`✓ Retrieved content: ${content.length} characters`);

  await browser.close();
  console.log('✓ Workflow complete');
}

/**
 * Run all tests sequentially
 */
export async function runAllTests(cdpEndpoint: string) {
  console.log('='.repeat(60));
  console.log('Running Comprehensive Integration Tests');
  console.log('='.repeat(60));

  const tests = [
    testBasicNavigation,
    testJavaScriptEvaluation,
    testElementInteraction,
    testWaitForSelector,
    testScreenshot,
    testMultiplePages,
    testBrowserContext,
    testPageContent,
    testFrameAccess,
    testErrorHandling,
    testExistingPageConnection,
    testRealWorldWorkflow,
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    try {
      await test(cdpEndpoint);
      passed++;
      console.log(`\n✅ ${test.name} PASSED\n`);
    } catch (error) {
      failed++;
      console.error(`\n❌ ${test.name} FAILED:`);
      console.error(error);
      console.log();
    }
  }

  console.log('='.repeat(60));
  console.log(`Test Results: ${passed} passed, ${failed} failed`);
  console.log('='.repeat(60));
}

/**
 * Example usage in natstack panel:
 *
 * ```typescript
 * import { runAllTests } from './INTEGRATION_TEST_EXAMPLE';
 *
 * // In your panel component:
 * const runTests = async () => {
 *   const cdpUrl = await panel.browser.getCdpEndpoint(browserId);
 *   await runAllTests(cdpUrl);
 * };
 * ```
 */
