/** Headless checks for the document model and export renderers. */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createReport, reportText, buildSections } from '../js/doc.js';
import { validate } from '../js/validate.js';
import { toText, toHTML, toFHIR, toPDF, verifyPDF } from '../js/export.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'templates.json'), 'utf8'));

let failures = 0;
const check = (name, cond, detail = '') => {
  if (cond) {
    console.log(`  ok   ${name}`);
  } else {
    failures++;
    console.log(`  FAIL ${name} ${detail}`);
  }
};

// --- pick representative templates -----------------------------------------
const mrBrain = data.templates.find((t) => t.name === 'MR Brain');
const aast = data.templates.find((t) => t.name === 'AAST Liver Injury Grade');
const xrChest = data.templates.find((t) => t.name === 'XR Chest');

console.log('\n[doc] sections built from token stream');
for (const t of [mrBrain, aast, xrChest]) {
  const secs = buildSections(t);
  check(`${t.name}: ${secs.length} sections, first = ${secs[0]?.heading}`, secs.length > 0);
}

console.log('\n[validate] empty report must be blocked');
{
  const r = createReport(mrBrain);
  const v = validate(r, mrBrain);
  check('hard issues present on empty report', v.counts.hard > 0, JSON.stringify(v.counts));
  check('cannot sign', v.canSign === false);
  console.log('    issues:', v.issues.map((i) => `${i.severity}:${i.id}`).join(', '));
}

console.log('\n[validate] filled report should clear hard errors');
const report = createReport(mrBrain, { accession: 'ACC-2026-4821', demographics: '56F' });
{
  // fill every enum field, and set impression
  for (const f of mrBrain.fields) {
    if (f.type === 'enum') report.fieldValues[f.key] = f.options[0];
    if (f.type === 'number') report.fieldValues[f.key] = '12';
  }
  const imp = report.sections.find((s) => s.heading === 'IMPRESSION');
  imp.tokens = [{ t: 'text', text: '\nUnremarkable brain MRI. No acute intracranial abnormality.' }];
  report.edited = true;
  const v = validate(report, mrBrain);
  check('no hard issues once filled', v.counts.hard === 0, JSON.stringify(v.issues.filter((i) => i.severity === 'hard')));
  console.log('    soft:', v.counts.soft, 'nudge:', v.counts.nudge);
}

console.log('\n[validate] placeholder leak is caught');
{
  const r = createReport(mrBrain);
  const sec = r.sections.find((s) => s.heading === 'FINDINGS');
  sec.tokens = [{ t: 'text', text: '\nBRAIN: [___] normal.\n' }];
  const v = validate(r, mrBrain);
  check('literal bracket detected', v.issues.some((i) => i.id.startsWith('placeholder-leak')));
}

console.log('\n[validate] minimal template without IMPRESSION is signable');
{
  const noImp = data.templates.find((t) => !t.sections.includes('IMPRESSION') && t.charCount > 200);
  const r = createReport(noImp);
  const imp = r.sections.find((s) => s.heading === 'FINDINGS');
  if (imp) imp.tokens = [{ t: 'text', text: '\nNormal study. No abnormality identified on this examination.' }];
  r.edited = true;
  const v = validate(r, noImp);
  const hasImpressionRule = v.issues.some((i) => i.id === 'IMPRESSION-empty');
  check(`no IMPRESSION rule applied to "${noImp.name}"`, !hasImpressionRule);
}

console.log('\n[text] render');
const txt = toText(report);
check('text contains EXAM heading', txt.includes('EXAM'));
check('text contains accession', txt.includes('ACC-2026-4821'));
check('text has no double blank runs', !/\n{4,}/.test(txt));

console.log('\n[html] render');
const html = toHTML(report);
check('html is well formed', html.startsWith('<!DOCTYPE html>') && html.trimEnd().endsWith('</html>'));
check('html escapes content', !html.includes('<script'));

console.log('\n[fhir] render');
const fhir = toFHIR(report);
check('resourceType', fhir.resourceType === 'DiagnosticReport');
check('status preliminary for draft', fhir.status === 'preliminary');
check('has presentedForm', Array.isArray(fhir.presentedForm) && fhir.presentedForm[0].data.length > 0);
check('conclusion derived from IMPRESSION', typeof fhir.conclusion === 'string' && fhir.conclusion.includes('Unremarkable'));

console.log('\n[pdf] structure');
const pdf = toPDF(report);
const problems = verifyPDF(pdf);
check(`pdf valid (${pdf.length} bytes, ${(pdf.length / 1024).toFixed(1)} KB)`, problems.length === 0, problems.join('; '));
const outPdf = path.join(__dirname, '..', 'sample-report.pdf');
fs.writeFileSync(outPdf, Buffer.from(pdf));
console.log('    wrote', outPdf);

console.log('\n[pdf] multi-page');
{
  const long = createReport(mrBrain);
  const sec = long.sections.find((s) => s.heading === 'FINDINGS');
  sec.tokens = [{ t: 'text', text: ('\n' + 'Long finding line that should wrap across the measure. '.repeat(40)) }];
  const big = toPDF(long);
  const p2 = verifyPDF(big);
  check(`multi-page pdf valid (${big.length} bytes)`, p2.length === 0, p2.join('; '));
}

console.log('\n[perf] render every template');
{
  const t0 = Date.now();
  let chars = 0;
  for (const t of data.templates) {
    const r = createReport(t);
    chars += reportText(r).length;
  }
  const ms = Date.now() - t0;
  console.log(`    ${data.templates.length} templates rendered in ${ms}ms (${chars} chars)`);
  check('render all under 2s', ms < 2000);
}

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
