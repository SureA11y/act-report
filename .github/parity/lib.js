'use strict';

// What every binding runner shares: where the released engine is, the
// engine's helpers with their defaults, the check that a binding runs that
// engine, and filing a result under its test case.

const path = require('node:path');

const CORE_DIR = path.resolve(process.env.CORE_DIR || 'core');

// Playwright's networkidle, as near as a runner without it gets: no request
// in flight for this long.
const QUIET_MS = 500;

function fromCore(id) {
  return require(require.resolve(id, { paths: [CORE_DIR] }));
}

// What the engine's runner shares with a runner of the caller's. A release
// with --runner-module passes these; an earlier one has cachedResponse in
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
// another copy of it. Returns the binding's own version.
function checkEngineVersion(bindingName) {
  const bindingPackage = require.resolve(`${bindingName}/package.json`, { paths: [CORE_DIR] });
  const expected = require(path.join(CORE_DIR, 'package.json')).version;
  const actual = require(
    require.resolve('@surea11y/core/package.json', { paths: [path.dirname(bindingPackage)] })
  ).version;
  if (actual !== expected) {
    throw new Error(`${bindingName} loads @surea11y/core ${actual}, not ${expected}`);
  }
  return require(bindingPackage).version;
}

// Filed under the test case, not the URL a page that refreshes itself away
// ends on. The engine's act-report.js does the same from the release that
// has --runner-module.
function fileUnderTestCase(result, caseUrl) {
  if (result && result.url !== caseUrl) result.url = caseUrl;
  return result;
}

function requireEnv(binding, ...names) {
  for (const name of names) {
    if (!process.env[name]) throw new Error(`${binding} needs ${name}`);
  }
}

module.exports = {
  CORE_DIR,
  QUIET_MS,
  fromCore,
  withDefaults,
  checkEngineVersion,
  fileUnderTestCase,
  requireEnv
};
