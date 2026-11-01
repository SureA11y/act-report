'use strict';

// Compares two implementation reports test case by test case: the outcome
// each gives for every rule on every test case. The assertor, the dates and
// the provenance node are left out, since a binding's report and the
// engine's own differ in those by design.
//
// Exits 0 when every outcome matches, 1 when any differs, and 2 when either
// file cannot be read as a report. Each difference is listed, grouped by how
// the outcome changed.
//
//   node .github/scripts/same-outcomes.js reference.jsonld binding.jsonld

const fs = require('node:fs');

function outcomesOf(file) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(report['@graph'])) throw new Error(`${file} has no @graph`);
  const outcomes = new Map();
  for (const node of report['@graph']) {
    if (node['@type'] !== 'TestSubject') continue;
    for (const assertion of node.assertions || []) {
      outcomes.set(`${node.source} ${assertion.test.title}`, assertion.result.outcome);
    }
  }
  return outcomes;
}

const [referenceFile, otherFile] = process.argv.slice(2);
let reference;
let other;
try {
  reference = outcomesOf(referenceFile);
  other = outcomesOf(otherFile);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}

const changes = new Map();
for (const key of new Set([...reference.keys(), ...other.keys()])) {
  const from = reference.get(key) || 'no assertion';
  const to = other.get(key) || 'no assertion';
  if (from === to) continue;
  const change = `${from} -> ${to}`;
  if (!changes.has(change)) changes.set(change, []);
  changes.get(change).push(key);
}

const differing = [...changes.values()].reduce((n, keys) => n + keys.length, 0);
console.log(
  `${reference.size} assertions in ${referenceFile}, ${other.size} in ${otherFile}: ` +
    `${differing ? `${differing} differ` : 'every outcome matches'}.`
);
for (const [change, keys] of changes) {
  console.log(`\n${change} (${keys.length}):`);
  for (const key of keys.sort()) console.log(`  ${key}`);
}
process.exit(differing ? 1 : 0);
