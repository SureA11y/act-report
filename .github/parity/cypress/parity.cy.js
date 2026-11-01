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

// The scan, as a user's spec writes it: the XML viewer check, then the
// binding, its result recorded under the test case.
function scan(testCase, Builder) {
  return cy.document({ log: false }).then((doc) => {
    if (doc.getElementById('xml-viewer-style')) {
      return cy.task('record', { key: testCase.key, xmlViewer: true }, { log: false });
    }
    return new Builder()
      .withRules(testCase.includeRuleIds)
      .options(testCase.engineOptions)
      .analyze()
      .then((result) => cy.task('record', { key: testCase.key, result }, { log: false }));
  });
}

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

      // A test case may navigate itself to another origin (a meta refresh to
      // another site): the engine's runner, before 1.15, follows it and scans
      // where it lands. Cypress runs commands on another origin only inside
      // cy.origin(), so the scan goes there, as a user's spec would.
      cy.location('origin', { log: false }).then((origin) => {
        if (origin === new URL(testCase.caseUrl).origin) return scan(testCase, A11yCoreBuilder);
        // cy.origin() runs its callback on that origin, serialized: it sees
        // only its arguments, loads the binding there
        // (experimentalOriginDependencies), and can't run a task, so it hands
        // the result back to be recorded here.
        return cy
          .origin(origin, { args: testCase }, (tc) => {
            // The handler above is this origin's too only once set here.
            Cypress.on('uncaught:exception', () => false);
            const { A11yCoreBuilder: Builder } = Cypress.require('@surea11y/cypress');
            return cy.document({ log: false }).then((doc) => {
              if (doc.getElementById('xml-viewer-style')) return { xmlViewer: true };
              return new Builder()
                .withRules(tc.includeRuleIds)
                .options(tc.engineOptions)
                .analyze()
                .then((result) => ({ result }));
            });
          })
          .then((scanned) => cy.task('record', { key: testCase.key, ...scanned }, { log: false }));
      });
    });
  }
});
