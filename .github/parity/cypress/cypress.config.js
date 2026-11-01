'use strict';

// The Cypress project the parity check runs: copied, with parity.cy.js, into
// a directory inside the engine's checkout, so the spec resolves the binding
// installed there. See ../runners/cypress.js.
//
// In Cypress's own Node process, it serves every request the page makes from
// the engine's cache (cachedResponse, the function the engine's runner
// answers from), through a local server the spec sends requests to, and
// records each test case's result in PARITY_RESULTS.

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { defineConfig } = require('cypress');

const CORE_DIR = process.env.CORE_DIR;
const { cachedResponse } = require(path.join(CORE_DIR, 'scripts/lib/act-browser.js'));

function startCacheServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://cache').searchParams.get('u');
    try {
      const cached = await cachedResponse(url);
      res.writeHead(cached.status, cached.contentType ? { 'content-type': cached.contentType } : {});
      res.end(cached.body);
    } catch {
      // Not in the cache and not fetched: as the engine's runner fails it.
      res.destroy();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

module.exports = defineConfig({
  video: false,
  screenshotOnRunFailure: false,
  e2e: {
    // A test case that navigates to another origin is scanned there, inside
    // cy.origin(), which loads the binding with Cypress.require().
    experimentalOriginDependencies: true,
    specPattern: 'parity.cy.js',
    supportFile: false,
    pageLoadTimeout: Number(process.env.PARITY_LOAD_TIMEOUT_MS) || 120000,
    defaultCommandTimeout: Number(process.env.PARITY_LOAD_TIMEOUT_MS) || 120000,
    async setupNodeEvents(on, config) {
      const results = process.env.PARITY_RESULTS;
      on('task', {
        record(entry) {
          fs.appendFileSync(results, `${JSON.stringify(entry)}\n`);
          return null;
        }
      });
      // For the spec: Cypress 16 reads them with Cypress.expose(), from
      // config.expose; earlier releases with Cypress.env(), from config.env.
      const values = {
        cacheBase: await startCacheServer(),
        cases: JSON.parse(fs.readFileSync(process.env.PARITY_CASES, 'utf8')),
        settleMs: Number(process.env.PARITY_SETTLE_MS) || 2000
      };
      config.expose = { ...config.expose, ...values };
      config.env = { ...config.env, ...values };
      return config;
    }
  }
});
