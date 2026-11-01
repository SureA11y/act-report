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
// PARITY_BINDING names a runner in ./runners: playwright, puppeteer,
// webdriverio or selenium. puppeteer needs CHROME_BINARY, the engine runner's
// Chromium; webdriverio and selenium need it and CHROMEDRIVER_BINARY, the
// ChromeDriver of the same version. PARITY_DEBUG=1 logs each request the
// WebDriver bindings answer, and any they could not.
//
// What every runner keeps the same as the engine's runner, so the binding is
// the only difference: a fresh browser state per test case; every request
// answered from the same cache (the engine's cachedResponse), so both scan
// the same bytes and w3.org is asked for each file once; the same wait after
// load; the same check for a document Chromium shows through its XML viewer;
// the page kept on its test case where the engine's runner keeps it
// (leavesTestCase, from the release that has it); and the result filed under
// the test case's URL. The binding runs as documented, with no hooks
// installed: what a user gets from the basic setup.

const path = require('node:path');
const { CORE_DIR, withDefaults } = require('./lib.js');

const RUNNERS = ['playwright', 'puppeteer', 'webdriverio', 'selenium'];
const BINDING = process.env.PARITY_BINDING;
if (!RUNNERS.includes(BINDING)) {
  throw new Error(`PARITY_BINDING must be one of ${RUNNERS.join(', ')}, not ${BINDING}`);
}
const { openRunner } = require(`./runners/${BINDING}.js`);

/** The runner module act-report.js --runner-module loads. */
function openBrowserRunner(options = {}, helpers = {}) {
  return openRunner(options, withDefaults(helpers));
}
module.exports = { openBrowserRunner };

// When act-report.js loads this with --runner-module, require.main is that
// script; when Node preloads it with -r, no main module has loaded yet.
if (!require.main) {
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
