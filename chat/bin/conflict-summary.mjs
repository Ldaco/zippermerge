#!/usr/bin/env node
// Summarize the dashboard's trial-merge conflicts: genuine cross-session pairs vs needs-rebase, and common files.
const b = await (await fetch(`http://127.0.0.1:${process.env.PORT || 4747}/api/board`)).json();
const c = b.conflicts || {};
const pairs = (c.pairs || []).filter((p) => !p.error && p.clean !== true);
const cross = pairs.filter((p) => p.kind !== 'vs-main' && p.viaMain !== true);
const vsMain = pairs.filter((p) => p.kind === 'vs-main');
console.log(`genuineCount=${c.genuineCount} viaMainCount=${c.viaMainCount} cross(genuine)=${cross.length} vsMain=${vsMain.length}`);
const byPair = {};
const fileFreq = {};
for (const p of cross) {
  const k = `${p.a.owner}:${p.a.branch} x ${p.b.owner}`;
  byPair[k] = (byPair[k] || 0) + 1;
  for (const f of p.files || []) fileFreq[f] = (fileFreq[f] || 0) + 1;
}
console.log('cross pairs by branch:', JSON.stringify(byPair, null, 1));
console.log('top files:', Object.entries(fileFreq).sort((x, y) => y[1] - x[1]).slice(0, 8).map(([f, n]) => `${n} ${f}`).join('\n  '));
const vm = {};
for (const p of vsMain) vm[`${p.a.owner}:${p.a.branch}`] = (p.files || []).length;
console.log('needs rebase vs main (files):', JSON.stringify(vm));
const sample = cross[0];
if (sample) console.log('sample pair:', sample.a.branch, 'x', sample.b.branch, 'files:', (sample.files || []).slice(0, 6).join(', '));
