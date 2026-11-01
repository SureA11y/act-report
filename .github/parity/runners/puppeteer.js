'use strict';

// @surea11y/puppeteer: a fresh browser context per test case, every request
// answered from the engine's cache through Puppeteer's request interception.
// Puppeteer launches the Chromium the engine's runner uses (CHROME_BINARY),
// not the Chrome it downloads for itself, so both scan in the same browser.

const { QUIET_MS, fromCore, checkEngineVersion, fileUnderTestCase, requireEnv } = require('../lib.js');

async function openPuppeteerRunner(options, helpers) {
  const { cachedResponse, leavesTestCase, SETTLE_MS, NAVIGATION_TIMEOUT_MS } = helpers;
  requireEnv('puppeteer', 'CHROME_BINARY');
  const bindingVersion = checkEngineVersion('@surea11y/puppeteer');
  const puppeteer = fromCore('puppeteer');
  const { A11yCoreBuilder } = fromCore('@surea11y/puppeteer');
  const browser = await puppeteer.launch({
    executablePath: process.env.CHROME_BINARY,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });

  async function scan(caseUrl, { runOnly, engineOptions }) {
    const context = await browser.createBrowserContext();
    let unreachable = null;
    try {
      const page = await context.newPage();
      await page.setRequestInterception(true);
      page.on('request', async (request) => {
        const url = request.url();
        try {
          if (
            leavesTestCase &&
            request.isNavigationRequest() &&
            request.frame() === page.mainFrame() &&
            leavesTestCase(url, caseUrl)
          ) {
            await request.abort('aborted');
            return;
          }
          if (!/^https?:/.test(url)) {
            await request.continue();
            return;
          }
          let res;
          try {
            res = await cachedResponse(url, options);
          } catch (err) {
            unreachable = unreachable || `${url}: ${err.message}`;
            await request.abort('failed');
            return;
          }
          await request.respond({
            status: res.status,
            headers: res.contentType ? { 'content-type': res.contentType } : {},
            body: res.body
          });
        } catch {
          // The context may have closed and dropped the request.
        }
      });
      await page.goto(caseUrl, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
      await page.waitForNetworkIdle({ idleTime: QUIET_MS, timeout: SETTLE_MS }).catch(() => {});
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
    version: `${await browser.version()}, @surea11y/puppeteer ${bindingVersion}`,
    close: () => browser.close()
  };
}

module.exports = { openRunner: openPuppeteerRunner };
