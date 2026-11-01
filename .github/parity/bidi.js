'use strict';

// The runner for bindings that drive Chromium through ChromeDriver
// (webdriverio, selenium). WebDriver has no per-request fulfil of its own;
// WebDriver BiDi does (network.addIntercept, network.provideResponse). The
// fresh state a new Playwright context gives is a BiDi user context here:
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
//
// A response body crosses ChromeDriver base64-encoded, far slower than
// Playwright's fulfil for a large file (f51b46 plays a 35 MB video, and a
// media element holds the page's load until its metadata arrives). The
// outcome is what is compared, not the time, so loading gets four times as
// long as in the engine's runner.
//
// The binding's scan is a script, held to the session's script timeout (30 s
// by default; WebdriverIO 10 holds BiDi scripts to it too). A page still
// taking a large body through ChromeDriver can hold the scan past it on a
// slow runner (f51b46 on GitHub's), so each adapter sets it to loadTimeoutMs.
//
// A binding adapter provides, for one WebDriver session with BiDi:
//   openSession({ pageLoadStrategy, chromeArgs, loadTimeoutMs }) -> {
//     send(method, params) -> result   a raw BiDi command
//     on(event, listener)              a BiDi event
//     windowHandle() / switchToWindow(handle) / navigate(url) / execute(fn)
//     builder()                        the binding's A11yCoreBuilder for it
//     browserVersion, close()
//   }

const { STATUS_CODES } = require('node:http');
const { QUIET_MS, fileUnderTestCase } = require('./lib.js');

const DEBUG = !!process.env.PARITY_DEBUG;

const sessionCapabilities = {
  pageLoadStrategy: 'none',
  chromeArgs: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
};

async function openBidiRunner(adapter, options, helpers) {
  const { cachedResponse, leavesTestCase, SETTLE_MS, NAVIGATION_TIMEOUT_MS } = helpers;
  const loadTimeoutMs = NAVIGATION_TIMEOUT_MS * 4;
  const textHeader = (name, value) => ({ name, value: { type: 'string', value } });

  async function openSession() {
    const driver = await adapter.openSession({ ...sessionCapabilities, loadTimeoutMs });
    const session = { driver, home: await driver.windowHandle(), current: null };
    await driver.send('session.subscribe', { events: ['network.beforeRequestSent'] });
    await driver.send('network.addIntercept', { phases: ['beforeRequestSent'] });
    driver.on('network.beforeRequestSent', async (event) => {
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
          await driver.send('network.provideResponse', {
            request,
            statusCode: 204,
            reasonPhrase: 'No Content',
            headers: [],
            body: { type: 'string', value: '' }
          });
          return;
        }
        if (!/^https?:/.test(url)) {
          await driver.send('network.continueRequest', { request });
          return;
        }
        let res;
        try {
          res = await cachedResponse(url, options);
        } catch (err) {
          if (current) current.unreachable = current.unreachable || `${url}: ${err.message}`;
          await driver.send('network.failRequest', { request });
          return;
        }
        await driver.send('network.provideResponse', {
          request,
          statusCode: res.status,
          // BiDi refuses a response whose status has no reason phrase.
          reasonPhrase: STATUS_CODES[res.status] || 'Unknown',
          headers: res.contentType ? [textHeader('content-type', res.contentType)] : [],
          body: { type: 'base64', value: Buffer.from(res.body).toString('base64') }
        });
        if (DEBUG) console.error(`served ${url} ${res.status} ${res.body.length}B`);
      } catch (err) {
        // A request left blocked would hold the page's load for ever: fail
        // it instead. It may already be gone with a closed tab.
        if (DEBUG) console.error(`intercept ${url}: ${err.message}`);
        await driver.send('network.failRequest', { request }).catch(() => {});
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
  const { browserVersion } = idle[0].driver;
  async function acquire() {
    if (idle.length) return idle.pop();
    const session = await openSession();
    all.push(session);
    return session;
  }

  // The page's load, then Playwright's networkidle as near as WebDriver
  // allows: no request in flight for QUIET_MS, or SETTLE_MS at most.
  async function loadAndSettle({ driver, current }) {
    const until = Date.now() + loadTimeoutMs;
    while (!(await driver.execute(() => document.readyState === 'complete'))) {
      if (Date.now() > until) throw new Error(`${current.caseUrl} did not load`);
      await new Promise((r) => setTimeout(r, 50));
    }
    const settled = Date.now() + SETTLE_MS;
    while (Date.now() < settled) {
      if (current.pending === 0 && Date.now() - current.lastActivity >= QUIET_MS) return;
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  async function scan(caseUrl, { runOnly, engineOptions }) {
    const session = await acquire();
    const { driver } = session;
    const { userContext } = await driver.send('browser.createUserContext', {});
    const { context: tab } = await driver.send('browsingContext.create', {
      type: 'tab',
      userContext
    });
    try {
      session.current = { tab, caseUrl, pending: 0, lastActivity: Date.now(), unreachable: null };
      await driver.switchToWindow(tab);
      await driver.navigate(caseUrl);
      await loadAndSettle(session);
      if (session.current.unreachable) {
        throw new Error(`could not load ${session.current.unreachable}`);
      }
      if (await driver.execute(() => !!document.getElementById('xml-viewer-style'))) return null;
      const result = await driver
        .builder()
        .withRules(runOnly.includeRuleIds)
        .options(engineOptions)
        .analyze();
      return fileUnderTestCase(result, caseUrl);
    } finally {
      session.current = null;
      await driver.send('browsingContext.close', { context: tab }).catch(() => {});
      await driver.send('browser.removeUserContext', { userContext }).catch(() => {});
      await driver.switchToWindow(session.home).catch(() => {});
      idle.push(session);
    }
  }

  return {
    scan,
    browserVersion,
    close: () => Promise.all(all.map((s) => s.driver.close().catch(() => {})))
  };
}

module.exports = { openBidiRunner };
