import { context } from '../context.ts';
import { loadMessages } from '../messages.ts';

export async function run() {
  const ctx = context();
  const messages = loadMessages(ctx);
  const answered = new Set(messages.filter((m) => m.kind === 'reply').map((m) => m.re));
  const open = messages.filter((m) => m.kind === 'ask' && !answered.has(m.id));
  if (!open.length) console.log('No open asks.');
  for (const ask of open) console.log(`[${ask.id}] ${ask.from} asked ${ask.to.join(', ')}: ${ask.body}`);
}
