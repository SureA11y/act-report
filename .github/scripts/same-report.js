'use strict';

// Exits 0 when two reports differ only in the dates the generator stamps on
// each run (the project's dct:date and release.created), 1 when anything else
// differs, and 2 when either file cannot be read as a report.
//
//   node .github/scripts/same-report.js published.jsonld generated.jsonld

const fs = require('node:fs');

function withoutRunDates(file) {
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const node of report['@graph'] || []) {
    if (node['@type'] !== 'Project') continue;
    delete node['dct:date'];
    if (node.release) delete node.release.created;
  }
  return JSON.stringify(report);
}

const [published, generated] = process.argv.slice(2);
let same;
try {
  same = withoutRunDates(published) === withoutRunDates(generated);
} catch (err) {
  console.error(err.message);
  process.exit(2);
}
process.exit(same ? 0 : 1);
