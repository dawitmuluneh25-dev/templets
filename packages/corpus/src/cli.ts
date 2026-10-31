/**
 * Writes the corpus artefacts and reports what it found.
 *
 * Exit codes matter: 0 means every file imported and round-tripped, 2 means at
 * least one was quarantined. CI treats 2 as failure, which is the point — a
 * corpus that half-imported must not look like a corpus that imported.
 */
import fs from 'node:fs';
import path from 'node:path';

import { importCorpus } from './index.js';
import { defaultOutputDir, defaultProvenancePath } from './read.js';

function writeJson(file: string, value: unknown, pretty: boolean): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value);
  fs.writeFileSync(file, `${body}\n`, 'utf8');
}

const result = importCorpus();
const outputDir = defaultOutputDir();

// Provenance is the artefact a human reviews, so it is pretty-printed; the token
// streams are machine input and are written compact.
writeJson(defaultProvenancePath(), result.provenance, true);
writeJson(path.join(outputDir, 'templates.json'), result.templates, false);
writeJson(path.join(outputDir, 'quarantine.json'), result.quarantine, true);
writeJson(path.join(outputDir, 'stats.json'), result.stats, true);

const { stats } = result;

console.log('--- corpus import ---');
console.log(`files              ${stats.files}`);
console.log(`imported           ${stats.imported}`);
console.log(`quarantined        ${stats.quarantined}`);
console.log(`round-trip pass    ${stats.round_trip_pass}`);
console.log(`round-trip fail    ${stats.round_trip_fail}`);
console.log(`fields             ${stats.fields} (${stats.templates_with_fields} templates)`);
console.log(`residual brackets  ${stats.residual_bracket_templates} templates`);
console.log(`by provenance      ${JSON.stringify(stats.by_provenance)}`);
console.log(`by scope           ${JSON.stringify(stats.by_scope)}`);
console.log(`transformed        ${JSON.stringify(stats.transformed)}`);

if (stats.quarantined > 0) {
  console.log('QUARANTINED:');
  for (const record of result.quarantine.slice(0, 20)) {
    console.log(`  ${record.relpath} | ${record.reason} | ${record.detail}`);
  }
  process.exitCode = 2;
}
