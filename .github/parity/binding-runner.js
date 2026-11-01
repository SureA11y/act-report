'use strict';

// Scans the ACT test cases through a browser binding, for the parity check.
//
// A runner for the engine's report generator that scans through a binding's
// public API, as a user's test does, so scripts/act-report.js
// --runner=chromium writes the report that binding gives. binding-parity.yml
// compares it, test case by test case, with the report the engine's own
// runner gives on the same machine. It works two ways:
//
// - As a runner module, from the engine release that has --runner-module:
//     CORE_DIR=core PARITY_BINDING=playwright node core/scripts/act-report.js \
//       --runner=chromium --runner-module=.github/parity/binding-runner.js \
//       --out=playwright.jsonld
// - Preloaded, for an earlier release: it replaces the Chromium runner in
//   scripts/lib/act-browser.js before act-report.js loads it.
//     CORE_DIR=core PARITY_BINDING=playwright \
//       node -r ./.github/parity/binding-runner.js core/scripts/act-report.js \
//         --runner=chromium --out=playwright.jsonld
//
// PARITY_BINDING is playwright or webdriverio. webdriverio also needs
// CHROME_BINARY and CHROMEDRIVER_BINARY, a Chromium and the ChromeDriver of
// the same version.
//
// What it keeps the same as the engine's runner, so the binding is the only
// difference: a fresh browser state per test case; every request answered
// from the same cache (the engine's cachedResponse), so both scan the same
// bytes and w3.org is asked for each file once; the same wait after load; the
// same check for a document Chromium shows through its XML viewer; the page
// kept on its test case where the engine's runner keeps it (leavesTestCase,
// from the release that has it); and the result filed under the test case's
// URL, not the URL a page that refreshes itself away ends on. The binding runs as documented, with no hooks
// installed: what a user gets from the basic setup.

const path = require('node:path');

const CORE_DIR = path.resolve(process.env.CORE_DIR || 'core');
const BINDING = process.env.PARITY_BINDING;

// When act-report.js loads it with --runner-module, require.main is that
// script; when Node preloads it with -r, no main module has loaded yet.
const PRELOADED = !require.main;

// Playwright's networkidle, as near as WebDriver allows: no request in flight
// for this long.
const QUIET_MS = 500;

function fromCore(id) {
  return require(require.resolve(id, { paths: [CORE_DIR] }));
}

// What the engine's runner shares with a runner of the caller's. A release
// with --runner-module passes these; an earlier one has the first in
// scripts/lib/act-browser.js and the timings as constants (2000 and 30000 in
// 1.14), and no leavesTestCase: its runner follows a page that navigates away.
function withDefaults(helpers) {
  if (typeof helpers.cachedResponse !== 'function') {
    throw new Error(
      'The engine passes no cachedResponse; the parity check needs updating to the engine release it runs against.'
    );
  }
  const given = Object.fromEntries(
    Object.entries(helpers).filter(([, value]) => value !== undefined)
  );
  return { SETTLE_MS: 2000, NAVIGATION_TIMEOUT_MS: 30000, leavesTestCase: null, ...given };
}

// The binding has to run the engine release the report describes, not
// another copy of it.
function checkEngineVersion(bindingName) {
  const expected = require(path.join(CORE_DIR, 'package.json')).version;
  const coreForBinding = require.resolve('@surea11y/core/package.json', {
    paths: [path.dirname(require.resolve(`${bindingName}/package.json`, { paths: [CORE_DIR] }))]
  });
  const actual = require(coreForBinding).version;
  if (actual !== expected) {
    throw new Error(`${bindingName} loads @surea11y/core ${actual}, not ${expected}`);
  }
  return require(require.resolve(`${bindingName}/package.json`, { paths: [CORE_DIR] })).version;
}

function fileUnderTestCase(result, caseUrl) {
  if (result && result.url !== caseUrl) result.url = caseUrl;
  return result;
}

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

// WebDriver has no per-request fulfil of its own; WebDriver BiDi does
// (network.addIntercept, network.provideResponse), and webdriverio exposes it.
// The fresh state a new Playwright context gives is a BiDi user context here:
// each test case gets a tab of its own in a new one, in one of a few
// long-lived sessions, one per test case the generator runs at a time.
//
// Two things WebDriver needs that Playwright doesn't:
// - pageLoadStrategy 'none'. ChromeDriver otherwise waits on every navigation
//   the page starts, including one that is answered and abandoned, before any
//   later command; the runner waits for the page's load itself instead.
// - A navigation away from the test case is answered with an empty 204: a
//   navigation that gets 204 No Content is abandoned and the page stays (HTML,
//   "Navigation"), as Playwright's abort leaves it. Failing the request would
//   replace the page with an error page.
async function openWebdriverioRunner(options, helpers) {
  const { cachedResponse, leavesTestCase, SETTLE_MS, NAVIGATION_TIMEOUT_MS } = helpers;
  const bindingVersion = checkEngineVersion('@surea11y/webdriverio');
  const { remote } = fromCore('webdriverio');
  const { A11yCoreBuilder } = fromCore('@surea11y/webdriverio');
  for (const name of ['CHROME_BINARY', 'CHROMEDRIVER_BINARY']) {
    if (!process.env[name]) throw new Error(`webdriverio needs ${name}`);
  }
  const sessionOptions = {
    logLevel: 'error',
    connectionRetryTimeout: NAVIGATION_TIMEOUT_MS * 2,
    capabilities: {
      browserName: 'chrome',
      webSocketUrl: true,
      pageLoadStrategy: 'none',
      'goog:chromeOptions': {
        binary: process.env.CHROME_BINARY,
        args: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
      },
      'wdio:chromedriverOptions': { binary: process.env.CHROMEDRIVER_BINARY }
    }
  };

  const textHeader = (name, value) => ({ name, value: { type: 'string', value } });

  async function openSession() {
    const browser = await remote(sessionOptions);
    const session = { browser, home: await browser.getWindowHandle(), current: null };
    await browser.sessionSubscribe({ events: ['network.beforeRequestSent'] });
    await browser.networkAddIntercept({ phases: ['beforeRequestSent'] });
    browser.on('network.beforeRequestSent', async (event) => {
      if (!event.isBlocked) return;
      const current = session.current;
      const request = event.request.request;
      const url = event.request.url;
      if (current) {
        current.pending += 1;
        current.lastActivity = Date.now();
      }
      try {
        if (
          current &&
          leavesTestCase &&
          event.navigation &&
          event.context === current.tab &&
          leavesTestCase(url, current.caseUrl)
        ) {
          await browser.networkProvideResponse({
            request,
            statusCode: 204,
            reasonPhrase: 'No Content',
            headers: [],
            body: { type: 'string', value: '' }
          });
          return;
        }
        if (!/^https?:/.test(url)) {
          await browser.networkContinueRequest({ request });
          return;
        }
        let res;
        try {
          res = await cachedResponse(url, options);
        } catch (err) {
          if (current) current.unreachable = current.unreachable || `${url}: ${err.message}`;
          await browser.networkFailRequest({ request });
          return;
        }
        await browser.networkProvideResponse({
          request,
          statusCode: res.status,
          reasonPhrase: res.status === 200 ? 'OK' : '',
          headers: res.contentType ? [textHeader('content-type', res.contentType)] : [],
          body: { type: 'base64', value: Buffer.from(res.body).toString('base64') }
        });
      } catch {
        // The tab may have closed and dropped the request.
      } finally {
        if (current) {
          current.pending -= 1;
          current.lastActivity = Date.now();
        }
      }
    });
    return session;
  }

  const idle = [await openSession()];
  const all = [...idle];
  const browserVersion = idle[0].browser.capabilities.browserVersion;
  async function acquire() {
    if (idle.length) return idle.pop();
    const session = await openSession();
    all.push(session);
    return session;
  }

  // The page's load, then Playwright's networkidle as near as WebDriver
  // allows: no request in flight for QUIET_MS, or SETTLE_MS at most.
  async function loadAndSettle(session) {
    const { browser, current } = session;
    await browser.waitUntil(
      () => browser.execute(() => document.readyState === 'complete'),
      { timeout: NAVIGATION_TIMEOUT_MS, interval: 50, timeoutMsg: `${current.caseUrl} did not load` }
    );
    const until = Date.now() + SETTLE_MS;
    while (Date.now() < until) {
      if (current.pending === 0 && Date.now() - current.lastActivity >= QUIET_MS) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function scan(caseUrl, { runOnly, engineOptions }) {
    const session = await acquire();
    const { browser } = session;
    const { userContext } = await browser.browserCreateUserContext({});
    const { context: tab } = await browser.browsingContextCreate({ type: 'tab', userContext });
    try {
      session.current = { tab, caseUrl, pending: 0, lastActivity: Date.now(), unreachable: null };
      await browser.switchToWindow(tab);
      await browser.url(caseUrl);
      await loadAndSettle(session);
      if (session.current.unreachable) {
        throw new Error(`could not load ${session.current.unreachable}`);
      }
      if (await browser.execute(() => !!document.getElementById('xml-viewer-style'))) return null;
      const result = await new A11yCoreBuilder({ browser })
        .withRules(runOnly.includeRuleIds)
        .options(engineOptions)
        .analyze();
      return fileUnderTestCase(result, caseUrl);
    } finally {
      session.current = null;
      await browser.browsingContextClose({ context: tab }).catch(() => {});
      await browser.browserRemoveUserContext({ userContext }).catch(() => {});
      await browser.switchToWindow(session.home).catch(() => {});
      idle.push(session);
    }
  }

  return {
    scan,
    version: `Chrome/${browserVersion}, @surea11y/webdriverio ${bindingVersion}`,
    close: () => Promise.all(all.map((s) => s.browser.deleteSession().catch(() => {})))
  };
}

const RUNNERS = { playwright: openPlaywrightRunner, webdriverio: openWebdriverioRunner };
if (!RUNNERS[BINDING]) {
  throw new Error(`PARITY_BINDING must be one of ${Object.keys(RUNNERS).join(', ')}, not ${BINDING}`);
}

/** The runner module act-report.js --runner-module loads. */
function openBrowserRunner(options = {}, helpers = {}) {
  return RUNNERS[BINDING](options, withDefaults(helpers));
}
module.exports = { openBrowserRunner };

if (PRELOADED) {
  const actBrowser = require(path.join(CORE_DIR, 'scripts/lib/act-browser.js'));
  if (typeof actBrowser.openBrowserRunner !== 'function') {
    throw new Error(
      'scripts/lib/act-browser.js exports no openBrowserRunner to replace; ' +
        'the parity check needs updating to the engine release it runs against.'
    );
  }
  actBrowser.openBrowserRunner = (options = {}) =>
    openBrowserRunner(options, {
      cachedResponse: actBrowser.cachedResponse,
      leavesTestCase: actBrowser.leavesTestCase,
      SETTLE_MS: actBrowser.SETTLE_MS,
      NAVIGATION_TIMEOUT_MS: actBrowser.NAVIGATION_TIMEOUT_MS
    });
}
