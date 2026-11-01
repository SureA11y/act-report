'use strict';

// One test per ACT test case: the page is visited, every request it makes is
// answered from the engine's cache, and @surea11y/cypress scans it as a
// user's spec does, with the basic setup. Each result goes to Node through the
// record task. See ../runners/cypress.js.

const { A11yCoreBuilder } = require('@surea11y/cypress');

// Cypress 16 removed Cypress.env() for Cypress.expose(); the binding
// supports Cypress 13 and later.
const value = (key) =>
  typeof Cypress.expose === 'function' ? Cypress.expose(key) : Cypress.env(key);
const cases = value('cases');
const cacheBase = value('cacheBase');
const settleMs = value('settleMs');
const QUIET_MS = 500;

// A test case's own scripts may throw; that is the page's business, not a
// failed scan.
Cypress.on('uncaught:exception', () => false);

describe('ACT test cases', () => {
  for (const testCase of cases) {
    it(testCase.caseUrl, () => {
      const traffic = { pending: 0, lastActivity: Date.now() };
      cy.intercept({ url: /^https?:\/\// }, (req) => {
        if (req.url.startsWith(cacheBase)) return;
        traffic.pending += 1;
        traffic.lastActivity = Date.now();
        req.url = `${cacheBase}/?u=${encodeURIComponent(req.url)}`;
        req.on('after:response', () => {
          traffic.pending -= 1;
          traffic.lastActivity = Date.now();
        });
      });
      cy.visit(testCase.caseUrl, { failOnStatusCode: false });

      // The engine runner's wait after load: no request in flight for
      // QUIET_MS, or settleMs at most.
      const settled = Date.now() + settleMs;
      const settle = () =>
        cy.wrap(null, { log: false }).then(() => {
          const quiet = traffic.pending === 0 && Date.now() - traffic.lastActivity >= QUIET_MS;
          if (quiet || Date.now() > settled) return undefined;
          return cy.wait(50, { log: false }).then(settle);
        });
      settle();

      cy.document({ log: false }).then((doc) => {
        if (doc.getElementById('xml-viewer-style')) {
          return cy.task('record', { key: testCase.key, xmlViewer: true }, { log: false });
        }
        return new A11yCoreBuilder()
          .withRules(testCase.includeRuleIds)
          .options(testCase.engineOptions)
          .analyze()
          .then((result) => cy.task('record', { key: testCase.key, result }, { log: false }));
      });
    });
  }
});
