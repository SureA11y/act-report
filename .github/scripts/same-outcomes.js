'use strict';

// Compares two implementation reports test case by test case: the outcome
// each gives for every rule on every test case. The assertor, the dates and
// the provenance node are left out, since a binding's report and the
// engine's own differ in those by design.
//
// A test case the reference has no assertion on at all is one the engine's
// own runner could not read (act-report.js leaves such a case out of the
// report and exits 2). There is nothing to compare it with, so it is listed
// and left out, with a warning, rather than failing the comparison: the
// binding is not at fault. A test case the reference read and the other
// report did not is a difference like any other.
//
// A binding may differ in a way that is the platform's, not the binding's:
// --binding=<name> applies that binding's expected differences (EXPECTED,
// below). Each is matched by its exact pattern, listed with its reason, and
// not counted; any other difference still is.
//
// Exits 0 when every outcome compared matches, 1 when any differs, and 2
// when either file cannot be read as a report.
//
//   node .github/scripts/same-outcomes.js reference.jsonld binding.jsonld [--binding=cypress]

const fs = require('node:fs');

// By binding: the differences its platform gives, each a reason and a test
// of (source, rule, reference outcome, binding outcome).
const EXPECTED = {
  cypress: [
    {
      reason:
        'Cypress loads the page in an iframe; in a frame the page\'s canvas can let the parent show ' +
        'through, so for a page that paints no background the engine asks about contrast ' +
        '(BACKGROUND_NOT_OPAQUE_AT_ROOT) and leaves the text out of the ratio rules, where in a ' +
        'top-level page it measures it on the canvas',
      matches: (source, rule, from, to) =>
        from === 'earl:passed' &&
        ((rule === 'contrast-computable' && to === 'earl:cantTell') ||
          (['contrast-minimum', 'contrast-enhanced'].includes(rule) && to === 'earl:inapplicable'))
    },
    {
      reason:
        "cy.visit() opens only text/html: a standalone SVG or XML document can't be visited, " +
        'so there is no result to compare',
      matches: (source, rule, from, to) => to === 'no assertion' && /\.(svg|xml)$/.test(source)
    }
  ]
};

// Outcome by rule, by test case.
function outcomesOf(file) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(report['@graph'])) throw new Error(`${file} has no @graph`);
  const subjects = new Map();
  for (const node of report['@graph']) {
    if (node['@type'] !== 'TestSubject') continue;
    const outcomes = subjects.get(node.source) || new Map();
    for (const assertion of node.assertions || []) {
      outcomes.set(assertion.test.title, assertion.result.outcome);
    }
    subjects.set(node.source, outcomes);
  }
  return subjects;
}

const args = process.argv.slice(2);
const bindingArg = args.find((arg) => arg.startsWith('--binding='));
const [referenceFile, otherFile] = args.filter((arg) => !arg.startsWith('--'));
const expected = (bindingArg && EXPECTED[bindingArg.slice('--binding='.length)]) || [];
let reference;
let other;
try {
  reference = outcomesOf(referenceFile);
  other = outcomesOf(otherFile);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const unreadByReference = [...other.keys()].filter((source) => !reference.has(source)).sort();

const changes = new Map();
const accepted = new Map(expected.map((entry) => [entry, []]));
let compared = 0;
for (const [source, referenceOutcomes] of reference) {
  const otherOutcomes = other.get(source) || new Map();
  for (const rule of new Set([...referenceOutcomes.keys(), ...otherOutcomes.keys()])) {
    compared += 1;
    const from = referenceOutcomes.get(rule) || 'no assertion';
    const to = otherOutcomes.get(rule) || 'no assertion';
    if (from === to) continue;
    const known = expected.find((entry) => entry.matches(source, rule, from, to));
    if (known) {
      accepted.get(known).push(`${source} ${rule}: ${from} -> ${to}`);
      continue;
    }
    const change = `${from} -> ${to}`;
    if (!changes.has(change)) changes.set(change, []);
    changes.get(change).push(`${source} ${rule}`);
  }
}

const differing = [...changes.values()].reduce((n, keys) => n + keys.length, 0);
console.log(
  `${compared} assertions compared on the ${reference.size} test cases ${referenceFile} has: ` +
    `${differing ? `${differing} differ` : 'every outcome matches'}` +
    `${expected.length ? `, apart from the expected differences listed below` : ''}.`
);
for (const [change, keys] of changes) {
  console.log(`\n${change} (${keys.length}):`);
  for (const key of keys.sort()) console.log(`  ${key}`);
}
for (const [entry, keys] of accepted) {
  if (!keys.length) continue;
  console.log(`\nExpected, not counted (${keys.length}): ${entry.reason}.`);
  for (const key of keys.sort()) console.log(`  ${key}`);
}
if (unreadByReference.length) {
  console.log(
    `\n${unreadByReference.length} test case(s) the engine's runner could not read, left out:`
  );
  for (const source of unreadByReference) console.log(`  ${source}`);
  if (process.env.GITHUB_ACTIONS) {
    console.log(
      `::warning::${unreadByReference.length} test case(s) the engine's runner could not read were left out of the comparison`
    );
  }
}
process.exit(differing ? 1 : 0);
