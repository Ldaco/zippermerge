#!/usr/bin/env node
// For each genuine cross-session conflict pair: which conflicting files are NOT in either side's vs-main set.
const b = await (await fetch(`http://127.0.0.1:${process.env.PORT || 4747}/api/board`)).json();
const pairs = ((b.conflicts || {}).pairs || []).filter((p) => !p.error && p.clean !== true);
const stale = new Map(pairs.filter((p) => p.kind === 'vs-main').map((p) => [p.a.branch, new Set(p.files || [])]));
const extra = {};
for (const p of pairs.filter((x) => x.kind === 'cross-session' && !x.viaMain)) {
  const sa = stale.get(p.a.branch), sb = stale.get(p.b.branch);
  const left = (p.files || []).filter((f) => !(sa && sa.has(f)) && !(sb && sb.has(f)));
  for (const f of left) extra[f] = (extra[f] || 0) + 1;
  if (!left.length) console.log('fully inherited but not flagged:', p.a.branch, p.b.branch);
}
console.log('files outside both vs-main sets (count of pairs):');
for (const [f, n] of Object.entries(extra).sort((x, y) => y[1] - x[1])) console.log(`  ${n} ${f}`);
