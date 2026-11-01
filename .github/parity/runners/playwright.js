'use strict';

// @surea11y/playwright: a fresh browser context per test case, every request
// answered from the engine's cache through context.route, as the engine's own
// runner does.

const { fromCore, checkEngineVersion, fileUnderTestCase } = require('../lib.js');

async function openPlaywrightRunner(options, helpers) {
  const { cachedResponse, leavesTestCase, SETTLE_MS, NAVIGATION_TIMEOUT_MS } = helpers;
  const bindingVersion = checkEngineVersion('@surea11y/playwright');
  const { chromium } = fromCore('playwright');
  const { A11yCoreBuilder } = fromCore('@surea11y/playwright');
  const browser = await chromium.launch();

  async function scan(caseUrl, { runOnly, engineOptions }) {
    const context = await browser.newContext();
    let unreachable = null;
    try {
      await context.route('**/*', async (route) => {
        const request = route.request();
        const url = request.url();
        if (
          leavesTestCase &&
          request.isNavigationRequest() &&
          !request.frame().parentFrame() &&
          leavesTestCase(url, caseUrl)
        ) {
          return route.abort('aborted');
        }
        if (!/^https?:/.test(url)) return route.continue();
        try {
          const res = await cachedResponse(url, options);
          const headers = res.contentType ? { 'content-type': res.contentType } : {};
          await route.fulfill({ status: res.status, headers, body: res.body });
        } catch (err) {
          unreachable = unreachable || `${url}: ${err.message}`;
          await route.abort('failed');
        }
      });
      const page = await context.newPage();
      await page.goto(caseUrl, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
      await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
      if (unreachable) throw new Error(`could not load ${unreachable}`);
      if (await page.evaluate(() => !!document.getElementById('xml-viewer-style'))) return null;
      const result = await new A11yCoreBuilder({ page })
        .withRules(runOnly.includeRuleIds)
        .options(engineOptions)
        .analyze();
      return fileUnderTestCase(result, caseUrl);
    } finally {
      await context.close();
    }
  }

  return {
    scan,
    version: `${browser.version()}, @surea11y/playwright ${bindingVersion}`,
    close: () => browser.close()
  };
}

module.exports = { openRunner: openPlaywrightRunner };
