import type { Message } from '../types.ts';
import type { Args } from '../types.ts';
import { join } from 'node:path';
import { context, requireAgent } from '../context.ts';
import { UserError } from '../errors.ts';
import { sendMessage } from '../messages.ts';
import { readJson } from '../store.ts';

export async function run({ positionals }: Args) {
  const [id, ...body] = positionals;
  const ctx = context();
  const from = requireAgent(ctx);
  if (!id) throw new UserError('Usage: zippermerge reply <message id> <text>');
  const parent = readJson<Message>(join(ctx.store, 'messages', `${id}.json`));
  if (!parent) throw new UserError(`No message ${id}.`);
  const message = sendMessage(ctx, { from, to: [parent.from], kind: 'reply', re: id, body: body.join(' ') });
  console.log(message.id);
}
