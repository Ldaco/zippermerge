#!/usr/bin/env node
// Sends one message through the dashboard's "Message agents" endpoint (logged as from the human, via: dashboard).
// Only for when the human explicitly asks to send a specific message on their behalf. Usage:
//   node bin/dashboard-post-as-human.mjs <kind> <text-file> [to]
import { readFileSync } from 'node:fs';

const [kind, textFile, to] = process.argv.slice(2);
if (!kind || !textFile) { console.log('usage: dashboard-post-as-human.mjs <kind> <text-file> [to]'); process.exit(2); }
const base = `http://127.0.0.1:${process.env.PORT || 4747}`;
const html = await (await fetch(`${base}/`)).text();
const marker = 'X-Zm-Token';
const tokenMatch = html.match(/["']([0-9a-f]{64})["']/);
if (!tokenMatch) { console.log(`no token found in the dashboard page (looked for a 64-hex string near ${marker})`); process.exit(1); }
const body = { kind, text: readFileSync(textFile, 'utf8').trim() };
if (to) body.to = to;
const res = await fetch(`${base}/api/post`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: base, [marker]: tokenMatch[1] },
  body: JSON.stringify(body),
});
console.log(res.status, await res.text());
