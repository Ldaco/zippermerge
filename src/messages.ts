import type { Agent, Ctx, Message, Receipt } from './types.ts';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UserError } from './errors.ts';
import { appendRecord, listJson, newId, readJson, writeExclusive } from './store.ts';

export const KINDS = ['note', 'ask', 'reply', 'done'];

const dir = (ctx: Ctx) => join(ctx.store, 'messages');

export function loadMessages(ctx: Ctx): Message[] {
  return listJson<Message>(dir(ctx));
}

export function knownNames(ctx: Ctx): Set<string> {
  const names = new Set(listJson<Agent>(join(ctx.store, 'agents')).map((agent) => agent.name));
  names.add(ctx.config.human);
  return names;
}

export interface NewMessage {
  from: string;
  to?: string[] | undefined;
  kind?: string;
  body?: string;
  re?: string | null;
  via?: string;
}

export function sendMessage(ctx: Ctx, { from, to, kind = 'note', body, re = null, via = 'cli' }: NewMessage): Message {
  if (!KINDS.includes(kind)) throw new UserError(`Unknown kind ${kind}. Use: ${KINDS.join(', ')}`);
  if (!body?.trim()) throw new UserError('A message needs a body.');
  if (!to?.length) throw new UserError('A message needs --to. Use a name, a comma list, or all.');
  const names = knownNames(ctx);
  for (const name of to) {
    if (name !== 'all' && !names.has(name)) throw new UserError(`Nobody here is called ${name}.`);
  }
  const id = newId();
  let thread = id; // a root message is its own thread
  if (re) {
    const parent = readJson<Message>(join(dir(ctx), `${re}.json`));
    if (!parent) throw new UserError(`No message ${re}.`);
    thread = parent.thread;
  }
  return appendRecord(dir(ctx), { id, from, to, kind, body, re, thread, via });
}

export function addressedTo(message: Message, name: string): boolean {
  return message.from !== name && (message.to.includes(name) || message.to.includes('all'));
}

const delivered = (ctx: Ctx, name: string, id: string) => join(ctx.store, 'delivered', name, `${id}.json`);
const acked = (ctx: Ctx, name: string, id: string) => join(ctx.store, 'acked', name, `${id}.json`);

export function unreadFor(ctx: Ctx, name: string): Message[] {
  return loadMessages(ctx).filter((message) => addressedTo(message, name) && !existsSync(delivered(ctx, name, message.id)));
}

/** Recorded per message and per reader, only for what was actually handed over. */
export function markDelivered(ctx: Ctx, name: string, id: string): void {
  writeExclusive(delivered(ctx, name, id), { id, name, ts: new Date().toISOString() });
}

export function markAcked(ctx: Ctx, name: string, id: string): void {
  writeExclusive(acked(ctx, name, id), { id, name, ts: new Date().toISOString() });
}

export function receipts(ctx: Ctx, message: Message, recipients: string[]): Record<string, Receipt> {
  const out: Record<string, Receipt> = {};
  for (const name of recipients) {
    const d = readJson<{ ts: string }>(delivered(ctx, name, message.id));
    const a = readJson<{ ts: string }>(acked(ctx, name, message.id));
    out[name] = { delivered: d?.ts ?? null, acked: a?.ts ?? null };
  }
  return out;
}

export function formatMessage(message: Message): string {
  const to = message.to.join(', ');
  return `[${message.id}] ${message.ts} ${message.kind} from ${message.from} to ${to}\n${message.body}`;
}
