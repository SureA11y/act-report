'use strict';

// @surea11y/cypress. A Cypress spec drives the browser itself, from inside
// Cypress's own runner, so there is no handle to scan one test case at a
// time from here. Instead, when the engine's report generator opens this
// runner, it works out the same test cases and scan options the generator
// will ask for, runs Cypress once over all of them (../cypress), and keeps
// each result; scan() then hands back the one asked for.
//
// Cypress loads the page under test in an iframe of its own runner, as it
// does for every Cypress user; that is part of what this binding's results
// are checked for. Every request the page makes is answered from the engine's
// cache through a local server in Cypress's Node process, and the binding
// runs with its basic setup: no plugin, no hooks.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CORE_DIR, fromCore, checkEngineVersion, fileUnderTestCase, requireEnv } = require('../lib.js');

const PROJECT_FILES = ['cypress.config.js', 'parity.cy.js'];

const keyOf = (caseUrl, includeRuleIds) => `${caseUrl} ${includeRuleIds.join(',')}`;

// The test cases act-report.js scans, with its --act filter: the manifest's
// entries the corpus publishes, every case of each, with the engine's own
// scan options.
async function testCases(options) {
  const corpusLib = require(path.join(CORE_DIR, 'scripts/lib/act-corpus.js'));
  const actArg = process.argv.find((arg) => arg.startsWith('--act='));
  const entries = corpusLib.loadManifest(actArg ? actArg.slice('--act='.length) : undefined);
  const corpus = await corpusLib.loadCorpus(options);
  const cases = [];
  for (const entry of entries) {
    const rule = corpus.rules.get(entry.actId);
    if (!rule) continue;
    for (const expected of corpusLib.BUCKETS) {
      for (const caseUrl of rule.buckets[expected]) {
        const { runOnly, engineOptions } = corpusLib.scanOptionsFor(
          entry.actId,
          entry.ourRuleIds,
          caseUrl
        );
        cases.push({
          key: keyOf(caseUrl, runOnly.includeRuleIds),
          caseUrl,
          includeRuleIds: runOnly.includeRuleIds,
          engineOptions
        });
      }
    }
  }
  return cases;
}

async function openCypressRunner(options, helpers) {
  requireEnv('cypress', 'CHROME_BINARY');
  const bindingVersion = checkEngineVersion('@surea11y/cypress');
  const cypress = fromCore('cypress');

  // The project sits inside the engine's checkout, so the spec's
  // require('@surea11y/cypress') resolves to the binding installed there.
  const project = fs.mkdtempSync(path.join(CORE_DIR, '.parity-cypress-'));
  for (const file of PROJECT_FILES) {
    fs.copyFileSync(path.join(__dirname, '..', 'cypress', file), path.join(project, file));
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-cypress-'));
  const casesFile = path.join(work, 'cases.json');
  const resultsFile = path.join(work, 'results.jsonl');
  fs.writeFileSync(casesFile, JSON.stringify(await testCases(options)));
  fs.writeFileSync(resultsFile, '');

  const env = {
    CORE_DIR,
    PARITY_CASES: casesFile,
    PARITY_RESULTS: resultsFile,
    PARITY_SETTLE_MS: String(helpers.SETTLE_MS),
    PARITY_LOAD_TIMEOUT_MS: String(helpers.NAVIGATION_TIMEOUT_MS * 4)
  };
  Object.assign(process.env, env);
  const run = await cypress.run({
    project,
    browser: process.env.CHROME_BINARY,
    headless: true,
    quiet: !process.env.PARITY_DEBUG
  });
  fs.rmSync(project, { recursive: true, force: true });
  if (run.status === 'failed') throw new Error(`Cypress did not run: ${run.message}`);

  const results = new Map();
  for (const line of fs.readFileSync(resultsFile, 'utf8').split('\n')) {
    if (!line) continue;
    const entry = JSON.parse(line);
    results.set(entry.key, entry);
  }

  async function scan(caseUrl, { runOnly }) {
    const entry = results.get(keyOf(caseUrl, runOnly.includeRuleIds));
    if (!entry) throw new Error('Cypress did not scan it (its test failed)');
    if (entry.xmlViewer) return null;
    return fileUnderTestCase(entry.result, caseUrl);
  }

  return {
    scan,
    version: `${run.browserName} ${run.browserVersion}, @surea11y/cypress ${bindingVersion}, Cypress ${run.cypressVersion}`,
    close: async () => fs.rmSync(work, { recursive: true, force: true })
  };
}

module.exports = { openRunner: openCypressRunner };
